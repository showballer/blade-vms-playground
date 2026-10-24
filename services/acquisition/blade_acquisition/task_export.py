"""Task ZIP export. Waveforms stay independent; no resampling or invented passages."""
from __future__ import annotations

import csv
import io
import hashlib
import math
import json
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone

from .csv_export import prepare_export, stream_csv
from .storage import ID_PATTERN, CHUNK_PATTERN


def point_cycle(record):
    value = record.get("pointCycle")
    return value if isinstance(value, dict) else {}


def task_identity(record):
    cycle = point_cycle(record)
    for kind, value in (("collection", cycle.get("collectionId")), ("session", cycle.get("sessionId")),
                        ("capture", record.get("captureSessionId"))):
        if isinstance(value, str) and ID_PATTERN.fullmatch(value):
            break
    else:
        kind, value = "record", record["id"]
    return (kind, value, *(str(record.get(key) or "").strip() for key in ("windFarm", "turbine", "object")))


def segment(value, fallback):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", str(value or ""))[:48].strip(" .")
    return value or fallback


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")


def csv_cell(value):
    # Metadata may be opened in Excel. Keep names from becoming formulas.
    return "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value


def export_identity(record, level):
    identity = task_identity(record)
    cycle = point_cycle(record)
    for key in (["bladeId", "radialPointId"] if level == "point" else ["bladeId"] if level == "blade" else []):
        value = cycle.get(key)
        if not isinstance(value, str) or not value.strip():
            return None
        identity += (value,)
    return identity


def prepare_task_export(store, recording_ids, level="task"):
    if level not in {"task", "blade", "point"}:
        raise ValueError("请选择任务、叶片或测点导出范围。")
    if (not isinstance(recording_ids, list) or not 1 <= len(recording_ids) <= 1000 or
            any(not isinstance(value, str) or not ID_PATTERN.fullmatch(value) for value in recording_ids) or
            len(set(recording_ids)) != len(recording_ids)):
        raise ValueError("请选择同一任务的有效记录（最多 1000 条，不能重复）。")
    records = [store._read_manifest(store.directory(value)) for value in recording_ids]
    identity = export_identity(records[0], level)
    if identity is None or any(export_identity(record, level) != identity for record in records):
        raise ValueError("记录不属于同一任务、叶片或测点，不能合并导出。")
    # The list/index intentionally limits its display size. Read authoritative
    # manifests here so an older record outside that page cannot be omitted
    # while calling the result an entire task.
    current_ids = set()
    for directory in store.root.iterdir():
        if not ID_PATTERN.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
            continue
        try:
            current = store._read_manifest(directory)
        except (OSError, ValueError):
            continue  # Unreadable records cannot be assigned an invented identity.
        if export_identity(current, level) == identity:
            current_ids.add(current["id"])
    if len(current_ids) > 1000:
        raise ValueError("所选范围超过 1000 条记录，请按叶片或测点分别导出。")
    if current_ids != set(recording_ids):
        raise BlockingIOError("所选范围的记录已变化，请刷新列表后重新导出。")
    records.sort(key=lambda record: (str(record.get("startedAt", "")), record["id"]))
    return records



def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _record_time(record):
    for key in ("endedAt", "startedAt"):
        value = record.get(key)
        if _number(value) and value:
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
    return 0


def _observation_state(record):
    completion = point_cycle(record).get("completion")
    if completion in {"cancelled", "missing_entry", "missing_exit", "signal_gap"}:
        return completion
    if record.get("status") == "error" or record.get("error") or completion == "device_error":
        return "failed"
    if record.get("status") != "complete":
        return "incomplete"
    if completion == "unconfirmed_pass":
        return completion
    if (completion == "confirmed_pass" and type(record.get("samples")) is int and record["samples"] > 0 and
            record.get("source") == "polytec_ivs500" and not record.get("simulation")):
        return "observed"
    return "incomplete"


def _segmented_plan(record):
    meta = point_cycle(record)
    if (meta.get("executionMode") != "manual_segments" or
            not isinstance(meta.get("collectionId"), str) or not ID_PATTERN.fullmatch(meta["collectionId"]) or
            not isinstance(meta.get("sessionId"), str) or not ID_PATTERN.fullmatch(meta["sessionId"]) or
            type(meta.get("cycles")) is not int or meta["cycles"] != 1 or
            type(meta.get("lapIndex")) is not int or meta["lapIndex"] != 1):
        return None
    count, step, plan = meta.get("totalStationCount"), meta.get("segmentStepDeg"), meta.get("plannedStations")
    if (type(count) is not int or not 2 <= count <= 16 or not _number(step) or not 0 < step <= 180 or
            abs(count * step - 360) > 1e-8 or not isinstance(plan, list) or len(plan) != count):
        return None
    text_keys = ("pointId", "bladeId", "radialPointId", "radialPointName")
    number_keys = ("radiusM", "azimuthDeg", "axis1AngleDeg", "axis2AngleDeg")
    optional_keys = ("rootRadiusM", "bladeLengthM", "distanceFromRootM")
    normalized = []
    for item in plan:
        if (not isinstance(item, dict) or any(not isinstance(item.get(key), str) or not item[key].strip() for key in text_keys) or
                any(not _number(item.get(key)) for key in number_keys) or
                any(key in item and not _number(item[key]) for key in optional_keys) or
                type(item.get("stationIndex")) is not int or type(item.get("stationCount")) is not int):
            return None
        normalized.append({key: item[key] for key in (*text_keys, *number_keys, "stationIndex", "stationCount", *optional_keys) if key in item})
    normalized.sort(key=lambda item: item["stationIndex"])
    if len({item["pointId"] for item in normalized}) != count:
        return None
    for index, item in enumerate(normalized):
        if (item["bladeId"] != meta.get("bladeId") or item["radialPointId"] != meta.get("radialPointId") or
                item["radiusM"] != meta.get("radiusM") or item["radiusM"] <= 0 or item["radiusM"] > 1000 or
                item["stationCount"] != count or item["stationIndex"] != index + 1 or
                abs(item["azimuthDeg"] - index * step) > 1e-8):
            return None
    selected = next((item for item in normalized if item["pointId"] == meta.get("pointId")), None)
    if not selected or any(meta.get(key) != selected[key] for key in ("stationIndex", "stationCount", "azimuthDeg")):
        return None
    if (any(not _number(meta.get(key)) or meta[key] != selected[plan_key] for key, plan_key in
            (("targetAxis1AngleDeg", "axis1AngleDeg"), ("targetAxis2AngleDeg", "axis2AngleDeg"))) or
            not isinstance(meta.get("segmentStationIds"), list) or not 1 <= len(meta["segmentStationIds"]) <= 2 or
            any(not isinstance(value, str) for value in meta["segmentStationIds"]) or
            len(set(meta["segmentStationIds"])) != len(meta["segmentStationIds"]) or
            meta["pointId"] not in meta["segmentStationIds"] or
            not set(meta["segmentStationIds"]).issubset({item["pointId"] for item in normalized})):
        return None
    for key in ("recordedPort", "referenceSignature"):
        if key in meta and not isinstance(meta[key], str):
            return None
    return normalized


def segmented_coverage(records):
    """Pool compatible manual segments only; latest retry determines each slot.

    Original records and failed retries remain in the archive. Complete means
    every planned position has a confirmed passage, never continuous phase.
    """
    groups, excluded, session_plans = {}, [], {}
    for record in records:
        meta = point_cycle(record)
        if meta.get("executionMode") != "manual_segments":
            continue
        plan = _segmented_plan(record)
        if plan is None:
            excluded.append(record["id"])
            if isinstance(meta.get("sessionId"), str):
                session_plans.setdefault(meta["sessionId"], set()).add(None)
            continue
        canonical_plan = [{key: (float(value) or 0.0) if _number(value) else value for key, value in station.items()
                           if key != "radialPointName"} for station in plan]
        scope = [task_identity(record), meta["bladeId"], meta["radialPointId"], canonical_plan,
                 float(meta["segmentStepDeg"]), meta["totalStationCount"], meta.get("recordedPort"), meta.get("referenceSignature")]
        fingerprint = hashlib.sha256(json.dumps(scope, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        session_plans.setdefault(meta["sessionId"], set()).add(fingerprint)
        if fingerprint not in groups:
            groups[fingerprint] = {"planKey": fingerprint, "collectionId": meta["collectionId"],
                "bladeId": meta["bladeId"], "radialPointId": meta["radialPointId"],
                "radialPointName": meta.get("radialPointName"), "radiusM": meta["radiusM"],
                "segmentStepDeg": meta["segmentStepDeg"], "plannedCount": len(plan),
                "coverageKind": "accumulated_manual_segment_passes", "continuousMeasurement": False,
                "sessionIds": [], "recordCount": 0, "stations": [{**item, "records": []} for item in plan]}
        group = groups[fingerprint]
        if meta["sessionId"] not in group["sessionIds"]:
            group["sessionIds"].append(meta["sessionId"])
        group["recordCount"] += 1
        next(item for item in group["stations"] if item["pointId"] == meta["pointId"])["records"].append(record)
    for group in groups.values():
        for station in group["stations"]:
            station_records = sorted(station.pop("records"), key=lambda item: (-_record_time(item), item["id"]))
            station.update(recordingIds=[item["id"] for item in station_records],
                           latestRecordingId=station_records[0]["id"] if station_records else None,
                           state=_observation_state(station_records[0]) if station_records else "unrecorded")
        group["observedCount"] = sum(station["state"] == "observed" for station in group["stations"])
        group["pendingCount"] = sum(station["state"] == "unrecorded" for station in group["stations"])
        group["planConflict"] = any(len(session_plans[session_id]) != 1 or None in session_plans[session_id]
                                    for session_id in group["sessionIds"])
        group["complete"] = not group["planConflict"] and group["observedCount"] == group["plannedCount"]
    return list(groups.values()), excluded


def build_task_archive(store, recording_ids, level="task"):
    records = prepare_task_export(store, recording_ids, level)
    output = tempfile.TemporaryFile(mode="w+b")
    entries = []
    try:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            for record in records:
                cycle = point_cycle(record)
                base = ("数据", "叶片_" + segment(cycle.get("bladeId"), "未标注"),
                    "测点_" + segment(cycle.get("radialPointName") or cycle.get("radialPointId") or record.get("point"), "未标注"))
                if cycle.get("executionMode") == "manual_segments":
                    # Every manual start has a separate session and lapIndex=1.
                    # That local lap is not a whole-circle observation: preserve
                    # global station/azimuth and every retry without pretending
                    # independent sessions were one continuous captured turn.
                    folder = "/".join((*base, "分段采集",
                        "点位_" + segment(cycle.get("stationIndex"), "未标注") +
                        "_角度_" + segment(cycle.get("azimuthDeg"), "0"),
                        "批次_" + segment(cycle.get("sessionId"), "未标注") + "_" + record["id"]))
                else:
                    folder = "/".join((*base,
                        "轮次_" + segment(cycle.get("lapIndex") or cycle.get("cycle"), "1"),
                        "点位_" + segment(cycle.get("stationIndex") or cycle.get("pointName"), "未标注") + "_" + record["id"]))
                directory = store.directory(record["id"])
                archive.writestr(folder + "/manifest.json", json_bytes(record))
                waveform, raw_files = None, []
                if record.get("status") == "complete" and record.get("samples", 0) > 0:
                    manifest, chunks = prepare_export(store, record["id"])
                    waveform = folder + "/waveform.csv"
                    with archive.open(waveform, "w", force_zip64=True) as target:
                        for part in stream_csv(manifest, chunks):
                            target.write(part.encode("utf-8"))
                else:
                    # Interrupted recordings are evidence, not successful measurements.
                    # Preserve their exact chunks, including partial tails, without
                    # inventing a valid CSV or silently dropping the record.
                    for source in sorted(directory.iterdir()):
                        if not CHUNK_PATTERN.fullmatch(source.name):
                            continue
                        if source.is_symlink() or not source.is_file():
                            raise ValueError("原始分块不是有效的本机文件。")
                        filename = folder + "/raw/" + source.name
                        with source.open("rb") as data, archive.open(filename, "w", force_zip64=True) as target:
                            shutil.copyfileobj(data, target, 65536)
                        raw_files.append(filename)
                telemetry = None
                source = directory / "turntable.jsonl"
                turntable = record.get("turntable")
                expected = turntable.get("telemetry") if isinstance(turntable, dict) else None
                if source.is_symlink():
                    raise ValueError("转盘遥测文件不能是符号链接。")
                if source.is_file():
                    telemetry = folder + "/turntable.jsonl"
                    with source.open("rb") as data, archive.open(telemetry, "w", force_zip64=True) as target:
                        shutil.copyfileobj(data, target, 65536)
                elif expected:
                    raise ValueError("记录声明的转盘遥测文件缺失，请检查本机原始数据。")
                rate = record.get("sampleRate")
                entries.append({"recordingId": record["id"], "name": record.get("name"),
                    "windFarm": record.get("windFarm"), "turbine": record.get("turbine"), "object": record.get("object"),
                    "bladeId": cycle.get("bladeId"), "point": cycle.get("radialPointName") or record.get("point"),
                    "radialPointId": cycle.get("radialPointId"), "radiusM": cycle.get("radiusM"),
                    "executionMode": cycle.get("executionMode") or "continuous",
                    "sessionId": cycle.get("sessionId"), "coverageKind": cycle.get("coverageKind"),
                    "stationCount": cycle.get("stationCount"),
                    "segmentStepDeg": cycle.get("segmentStepDeg"), "totalStationCount": cycle.get("totalStationCount"),
                    "lap": cycle.get("lapIndex") or cycle.get("cycle"), "station": cycle.get("stationIndex"),
                    "azimuthDeg": cycle.get("azimuthDeg"), "targetAxis1AngleDeg": cycle.get("targetAxis1AngleDeg"),
                    "targetAxis2AngleDeg": cycle.get("targetAxis2AngleDeg"), "status": record.get("status"),
                    "completion": cycle.get("completion"), "error": record.get("error"),
                    "startedAt": record.get("startedAt"), "endedAt": record.get("endedAt"),
                    "samples": record.get("samples"), "sampleRate": rate,
                    "durationSeconds": record.get("samples", 0) / rate if isinstance(rate, (int, float)) and rate > 0 else None,
                    "dataState": "csv" if waveform else "raw_unverified" if raw_files else "no_samples",
                    "waveform": waveform, "telemetry": telemetry, "manifest": folder + "/manifest.json", "rawFiles": raw_files})
            coverage, unassigned = segmented_coverage(records)
            archive.writestr("task.json", json_bytes({"format": "blade-vms-task-export-1",
                "exportedAt": datetime.now(timezone.utc).isoformat(), "taskIdentity": task_identity(records[0]),
                "exportLevel": level, "scopeIdentity": export_identity(records[0], level),
                "recordCount": len(entries), "records": entries,
                "segmentedCoverage": coverage, "unassignedSegmentedRecordingIds": unassigned}))
            if coverage:
                table = io.StringIO(newline="")
                writer = csv.writer(table, lineterminator="\n")
                writer.writerow(["planKey", "bladeId", "radialPointId", "radiusM", "segmentStepDeg", "observedCount",
                                 "plannedCount", "complete", "stationIndex", "azimuthDeg", "state", "latestRecordingId", "recordingIds"])
                for group in coverage:
                    for station in group["stations"]:
                        writer.writerow([csv_cell(value) for value in [group["planKey"], group["bladeId"], group["radialPointId"],
                            group["radiusM"], group["segmentStepDeg"], group["observedCount"], group["plannedCount"], group["complete"],
                            station["stationIndex"], station["azimuthDeg"], station["state"], station["latestRecordingId"],
                            ";".join(station["recordingIds"]) ]])
                archive.writestr("分段点位汇总.csv", table.getvalue().encode("utf-8-sig"))
            table = io.StringIO(newline="")
            columns = [key for key in entries[0] if key != "rawFiles"]
            writer = csv.writer(table, lineterminator="\n")
            writer.writerow(columns)
            writer.writerows([csv_cell(entry[key]) for key in columns] for entry in entries)
            archive.writestr("任务清单.csv", table.getvalue().encode("utf-8-sig"))
            archive.writestr("导出说明.txt", (
                f"导出范围：{ {'task': '整个任务', 'blade': '指定叶片', 'point': '指定叶片的测点'}[level] }。\n"
                "本包包含所选范围当前已保存的全部记录，按叶片、测点、轮次和点位分目录。\n"
                "分段采集按全圈点位序号、角度及人工开始批次分目录；跨批次补齐计划点位不表示单次连续整圈采集。\n"
                "任务清单.csv / task.json：各记录的标识、采集时间、时长、位置、保存状态和文件路径。\n"
                "executionMode=manual_segments 表示分段采集；sessionId 为每次人工开始的独立批次，station 为整圈点位序号。\n"
                "分段记录的 lap 是该次开始内的局部轮次，不能按 lap=1 推断已采完一圈；站数及移动间隔见 stationCount/totalStationCount/segmentStepDeg。\n"
                "分段点位汇总.csv / task.json.segmentedCoverage 按同任务、同叶片测点、相同全圈计划与参考累计；每点按最新记录判定，旧重采记录全部保留。\n"
                "complete 仅表示计划点位均已确认经过，不表示连续整圈或已核实目标叶片身份；计划信息不全的记录列入 unassignedSegmentedRecordingIds，不补判完整。\n"
                "waveform.csv：完整原始波形，时间单位秒、速度 m/s、RSSI %；保留原采样率，不降采样。\n"
                "manifest.json：完整点位计划、设备参数、进入/离开判定和有效样本区间等已有元数据。\n"
                "turntable.jsonl：该记录已保存的转盘反馈（若有）。\n"
                "异常或未完整结束的记录保留 manifest 和 raw 原始二进制分块，不伪造完整 CSV。\n"
                "清单 dataState：csv 为波形 CSV；raw_unverified 为完整性未经确认的原始分块；no_samples 为无已保存样本。\n"
                "移动、等待等已记录信号不会被删除；未采到的点位不会补数据。\n"
                "各点位文件独立保留，不将分段观测冒充连续整圈数据。\n"
            ).encode("utf-8-sig"))
        output.seek(0)
        return output
    except BaseException:
        output.close()
        raise
