"""Offline, reproducible extraction and experimental spatial reconstruction.

Run with the acquisition requirements installed, plus matplotlib for the figures.
Original task files are read-only; output goes to a separate new directory.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import html
import json
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blade_acquisition.blade_passes import _time_curve
from blade_acquisition.blade_synthesis import reconstruct_blade_passes
from blade_acquisition.receiver import Batch
from blade_acquisition.rssi_handoff import RssiHandoff
from blade_acquisition.storage import RecordingStore
from blade_acquisition.web_rotation import import_csv_stream


def _task_file(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("任务文件路径无效或越出原始任务目录。")
    return path


def replay_boundaries(path, manifest):
    config = SimpleNamespace(**manifest["turntable"]["config"])
    detector = RssiHandoff(config, 0)
    rows = np.loadtxt(path, delimiter=",", skiprows=2, usecols=(1, 2), ndmin=2)
    rate = manifest["sampleRate"]
    for start in range(0, len(rows), 10000):
        section = rows[start:start + 10000]
        detector.feed(Batch(start, rate, manifest["sampleOrigin"], [], section[:, 0].tolist(),
                            [], section[:, 1].tolist(), [False] * len(section)))
        if detector.trigger:
            break
    saved = manifest["pointCycle"]["handoff"]
    fields = ("entrySampleIndex", "entryConfirmedSampleIndex", "exitSampleIndex", "exitConfirmedSampleIndex")
    delta = {key: detector.trigger[key] - saved[key] if detector.trigger else None for key in fields}
    window = max(1, int(np.ceil(rate * config.rssiSmoothingMs / 1000)))
    spreads = []
    for start in range(0, len(rows) - window + 1, window):
        chunk = rows[start:start + window, 1]
        spreads.append([(start + window) / rate, float(np.percentile(chunk, 90) - np.percentile(chunk, 10))])
    return {"matchesSavedBoundaries": all(value == 0 for value in delta.values()),
            "deltaSamples": delta, "savedBoundaries": {key: saved[key] for key in fields},
            "replayedBoundaries": {key: detector.trigger[key] for key in fields} if detector.trigger else None,
            "windowSeconds": window / rate, "enterSpread": config.rssiEnterSpread,
            "exitSpread": config.rssiExitSpread, "spreadCurve": spreads,
            "rawWaveform": _time_curve(rows[:, 0], 0, rate),
            "interpretation": "detector reproducibility only; no independent blade-edge ground truth"}


def _figures(output, result, audits):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False})
    fig, axes = plt.subplots(len(audits), 1, figsize=(12, max(8, len(audits) * 1.7)), squeeze=False)
    for ax, audit in zip(axes[:, 0], audits):
        wave, saved = audit["rawWaveform"], audit["savedBoundaries"]
        rate = audit["sampleRate"]
        ax.plot(wave["seconds"], np.asarray(wave["values"]) * 1000, color="#2d6cc0", linewidth=.7)
        ax.axvspan((saved["entryConfirmedSampleIndex"] + 1) / rate, saved["exitSampleIndex"] / rate,
                   color="#2ca06c", alpha=.18)
        twin = ax.twinx()
        curve = np.asarray(audit["spreadCurve"])
        twin.plot(curve[:, 0], curve[:, 1], color="#d97a29", linewidth=.6, alpha=.8)
        twin.axhline(audit["enterSpread"], color="#d97a29", linestyle=":", linewidth=.6)
        twin.axhline(audit["exitSpread"], color="#a25b23", linestyle=":", linewidth=.6)
        twin.set_ylabel("RSSI spread / %")
        ax.set_ylabel("mm/s")
        ax.set_title(f"{audit['point']} / {audit['azimuthDeg']:g} deg / {audit['sourceRecordingId'][:8]} | replay={'MATCH' if audit['matchesSavedBoundaries'] else 'MISMATCH'}", loc="left", fontsize=9)
    axes[-1, 0].set_xlabel("Original recording time / s; green = extracted range; orange = RSSI P90-P10")
    fig.tight_layout()
    fig.savefig(output / "boundaries.png", dpi=135)
    plt.close(fig)

    points = result["synthesis"]["mergedPoints"]
    fig, axes = plt.subplots(len(points), 1, figsize=(12, 8), squeeze=False)
    for ax, point in zip(axes[:, 0], points):
        for index, segment in enumerate(point["segments"]):
            wave = segment.get("plotTimeDomain") or segment["timeDomain"]
            times = np.asarray(wave["seconds"]) - segment["originalStartSeconds"] + segment["compressedStartSeconds"]
            values = np.asarray([np.nan if value is None else value for value in wave["values"]], dtype=float)
            ax.plot(times, values * 1000, linewidth=.7, label=f"{segment['azimuthDeg']:g} deg / {segment['sourceRecordingId'][:6]}")
            if index:
                ax.axvline(segment["compressedStartSeconds"], color="#999999", linestyle=":", linewidth=.6)
        hidden = sum(segment.get("plotFilter", {}).get("hiddenTimeBuckets", 0) for segment in point["segments"])
        jumps = sum(segment.get("plotFilter", {}).get("flaggedSteps", 0) for segment in point["segments"])
        suffix = f" | plot gaps: {jumps} jumps / {hidden} buckets" if jumps else ""
        ax.set_title(f"{point['radialPointName']} | r={point['radiusM']:g} m | {point['durationSeconds']:.3f} s valid{suffix}", loc="left")
        ax.set_ylabel("mm/s")
        ax.legend(fontsize=6, loc="upper right", ncol=3)
    axes[-1, 0].set_xlabel("Compressed valid time / s (not physical continuous time)")
    fig.tight_layout()
    fig.savefig(output / "merged-points.png", dpi=160)
    plt.close(fig)

    synthesis = result["synthesis"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    if synthesis["spectrum"]:
        spectrum = synthesis["spectrum"]
        for point in spectrum["points"]:
            match = next(item for item in points if item["radialPointId"] == point["radialPointId"])
            axes[0].semilogy(spectrum["frequencies"], np.maximum(point["psd"], 1e-25), label=match["radialPointName"], linewidth=.8)
        axes[0].legend()
    responses = synthesis["candidates"] or synthesis["bandResponses"]
    for candidate in responses:
        axes[1].plot([p["radiusM"] for p in candidate["points"]],
                     [p["normalizedAmplitude"] for p in candidate["points"]], "o--", label=f"{candidate['bandHz'][0]:g}-{candidate['bandHz'][1]:g} Hz")
        if candidate["kind"] != "exploratory_band_response":
            axes[0].axvline(candidate["frequencyHz"], color="#999999", linestyle=":", linewidth=.5)
    axes[0].set(xlabel="Frequency / Hz", ylabel="Velocity PSD / (m/s)^2/Hz", title="Independent segment spectra, equal station weights")
    axes[1].set(xlabel="Measured radius / m", ylabel="Normalized band displacement RMS", ylim=(0, 1.08), title="Unsigned spatial responses (no common modal peak)" if not synthesis["candidates"] else "Unsigned shape candidates (phase unknown)")
    if responses:
        axes[1].legend()
    fig.tight_layout()
    fig.savefig(output / "shape-candidates.png", dpi=180)
    plt.close(fig)


def _report(output, result, audits):
    synthesis = result["synthesis"]
    rows = "".join(f"<tr><td>{html.escape(point['radialPointName'])}</td><td>{point['radiusM']:.3f}</td><td>{point['samples']:,}</td><td>{point['durationSeconds']:.3f}</td><td>{len(point['segments'])}</td></tr>" for point in synthesis["mergedPoints"])
    responses = synthesis["candidates"] or synthesis["bandResponses"]
    candidates = "".join(f"<tr><td>{i + 1}</td><td>{candidate['bandHz'][0]:g}～{candidate['bandHz'][1]:g}</td><td>{', '.join(format(point['normalizedAmplitude'], '.3f') for point in candidate['points'])}</td><td>{html.escape(' '.join(candidate['warnings']))}</td></tr>" for i, candidate in enumerate(responses))
    warnings = "".join(f"<li>{html.escape(item)}</li>" for item in synthesis["assumptions"])
    quality = "".join(f'<p class="note">{html.escape(item)}</p>' for item in synthesis.get("qualityWarnings", []))
    excluded_count = len(result["offlineValidation"]["excludedTaskRecords"])
    coverage = result["coverage"]
    report = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>叶片片段合并与振型候选验证</title>
<style>body{{font:15px/1.65 system-ui,sans-serif;color:#242424;margin:32px auto;padding:0 20px;max-width:1200px}}h1{{font-size:25px}}h2{{font-size:20px;margin-top:32px}}table{{border-collapse:collapse;width:100%}}th,td{{padding:9px 12px;text-align:left;border-bottom:1px solid #ddd}}th{{background:#f1f3f4}}img{{width:100%;height:auto}}p,li{{max-width:1000px}}.note{{padding:12px;border-left:4px solid #c58228;background:#fff8ed}}a{{color:#245c9d}}</style>
<h1>叶片有效片段合并与振型候选</h1><p>叶片 {html.escape(result['bladeId'])}；按同一叶片处理。原任务 {coverage['selectedRecords'] + excluded_count} 条记录，其中 {excluded_count} 条未完成/异常记录未纳入。{coverage['includedRecords']} 条完整记录，{coverage['segmentCount']} 个有效段，{coverage['validSamples']:,} 个样本，共 {coverage['validSeconds']:.3f} 秒。</p>
<p class="note">完成有效段数据合并，并按共同频带生成无符号空间响应候选。真实跨点相位尚未测得，因此不能确定模态节点正负、确认固有模态或据此判断损伤。压缩时间不代表真实连续采集。</p>
{quality}
<h2>各径向点合并结果</h2><table><tr><th>测点</th><th>半径 m</th><th>有效样本</th><th>有效秒数</th><th>片段数</th></tr>{rows}</table><p class="note">合并波形图仅对异常大单步变化附近的显示时间桶留空并断线，以便观察其余波形。原始样本、合并 CSV、统计指标、频谱和振型候选均未过滤。</p><img src="merged-points.png" alt="四个测点的合并有效波形，异常突跳附近断线，虚线保留拼接边界">
<h2>共同频带与空间曲线</h2><p>分段 Welch 谱先独立计算；重复点位按时长、不同角度等权汇总。搜索范围 {synthesis['parameters']['minHz']}～{synthesis['parameters']['maxHz']} Hz；每段至少覆盖 {synthesis['parameters']['minCycles']} 个周期才进入对应频带。</p><img src="shape-candidates.png" alt="共同频带的无符号响应振型候选"><table><tr><th>序号</th><th>频率 Hz</th><th>径向归一化幅值</th><th>适用范围</th></tr>{candidates}</table><p>{html.escape(synthesis.get('reason') or '')}</p>
<h2>边界复算</h2><p>{sum(a['matchesSavedBoundaries'] for a in audits)} / {len(audits)} 条记录的四个进入/离开样本边界与原采集检测器复算一致。这证明软件流程可复现；没有人工标注或独立触发器，尚不能量化真实叶缘检测误差。绿色区域为提取范围，橙线为 RSSI 窗口变动幅度。</p><img src="boundaries.png" alt="所有记录原始速度、RSSI变化与有效边界">
<h2>合成假设</h2><ul>{warnings}</ul><p><a href="result.json">完整结果 JSON</a> · <a href="segments.csv">片段索引与来源</a> · <a href="shape-candidates.csv">候选频带及测点幅值</a></p><p>每个测点的 merged-P*.csv.gz 保存全采样率原始速度和处理后速度；compressed_time_s 为压缩坐标。原始样本索引、片段号与来源记录保留，不用拼接信号的 FFT 冒充更长观测。</p></html>"""
    (output / "report.html").write_text(report, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--min-hz", type=float, default=20)
    parser.add_argument("--max-hz", type=float, default=2000)
    parser.add_argument("--detrend", choices=("linear", "constant", "none"), default="linear")
    parser.add_argument("--no-plots", action="store_true")
    args = parser.parse_args()
    root, output = args.task.resolve(), args.output.resolve()
    if output == root or output.is_relative_to(root):
        parser.error("输出目录须在原始任务目录之外。")
    task = json.loads((root / "task.json").read_text(encoding="utf-8"))
    records = sorted(task["records"], key=lambda record: (record.get("startedAt", 0), record["recordingId"]))
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("请使用空输出目录，避免覆盖之前的分析。")
    audits, imported, source_files, excluded = [], [], [], []
    with ExitStack() as stack:
        temporary = stack.enter_context(tempfile.TemporaryDirectory(prefix="native-", dir=output))
        store = RecordingStore(Path(temporary) / "rotation" / "recordings")
        for record in records:
            if record.get("status") != "complete" or not record.get("waveform"):
                excluded.append({"sourceRecordingId": record["recordingId"], "reason": record.get("completion") or record.get("status")})
                continue
            path = _task_file(root, record["waveform"])
            manifest = json.loads(_task_file(root, record["manifest"]).read_text(encoding="utf-8"))
            print(f"Import / replay: {record['point']} / {record['azimuthDeg']:g} deg / {record['recordingId'][:8]}", flush=True)
            response = import_csv_stream(store, path, path.name, {})
            imported.extend(item["id"] for item in response["recordings"])
            audit = replay_boundaries(path, manifest)
            audit.update(sourceRecordingId=record["recordingId"], point=record["point"],
                         azimuthDeg=record["azimuthDeg"], sampleRate=record["sampleRate"])
            audits.append(audit)
            with path.open("rb") as stream:
                source_files.append({"path": record["waveform"], "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
        writers, merged_files = {}, {}

        def sink(source, mapping, raw, processed):
            key = source["radialPointId"]
            if key not in writers:
                # Names generated from numeric radius order, never source labels/paths.
                merged_files[key] = f"merged-P{len(writers) + 1}.csv.gz"
                stream = stack.enter_context(gzip.open(output / merged_files[key], "wt", encoding="utf-8", newline=""))
                writer = csv.writer(stream)
                writer.writerow(["merged_index", "compressed_time_s", "segment_id", "source_recording_id", "original_sample_index", "original_time_s", "azimuth_deg", "raw_velocity_m_s", "processed_velocity_m_s"])
                writers[key] = writer
            writer = writers[key]
            rate, offset = source["sampleRate"], mapping["compressedStartSeconds"]
            writer.writerows((mapping["mergedStart"] + i, format(offset + i / rate, ".9f"), mapping["segmentId"],
                mapping["sourceRecordingId"], mapping["originalStart"] + i, format((mapping["originalStart"] + i) / rate, ".9f"),
                mapping["azimuthDeg"], format(float(raw[i]), ".17g"), format(float(processed[i]), ".17g")) for i in range(len(raw)))

        result = reconstruct_blade_passes(store, {"recordingIds": imported, "detrend": args.detrend,
            "synthesis": {"minHz": args.min_hz, "maxHz": args.max_hz}}, segment_sink=sink)
        for point in result["synthesis"]["mergedPoints"]:
            point["mergedFile"] = merged_files[point["radialPointId"]]
    result["offlineValidation"] = {"inputDirectory": str(root), "sourceFiles": source_files,
        "excludedTaskRecords": excluded, "boundaryAudits": audits,
        "allBoundariesReproduced": all(audit["matchesSavedBoundaries"] for audit in audits)}
    (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    with (output / "segments.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        fields = ["point", "radiusM", "segmentId", "sourceRecordingId", "azimuthDeg", "sampleRate", "originalStart", "originalEnd", "mergedStart", "mergedEnd", "compressedStartSeconds", "compressedEndSeconds", "rawSha256"]
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for point in result["synthesis"]["mergedPoints"]:
            for segment in point["segments"]:
                writer.writerow({**segment, "point": point["radialPointName"], "radiusM": point["radiusM"]})
    with (output / "shape-candidates.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["candidate", "band_center_hz", "band_low_hz", "band_high_hz", "point", "radius_m", "velocity_rms_m_s", "displacement_rms_m", "normalized_amplitude", "station_count", "phase_measured", "kind", "angle_amplitude_ratio"])
        for i, candidate in enumerate(result["synthesis"]["candidates"] or result["synthesis"]["bandResponses"]):
            for point in candidate["points"]:
                writer.writerow([i + 1, candidate["frequencyHz"], *candidate["bandHz"], point["radialPointName"], point["radiusM"], point["velocityRmsMps"], point["displacementRmsM"], point["normalizedAmplitude"], point["stationCount"], False, candidate["kind"], point["stationAmplitudeRatio"]])
    if not args.no_plots:
        _figures(output, result, audits)
        _report(output, result, audits)
    print(json.dumps({"output": str(output), "coverage": result["coverage"], "replayed": result["offlineValidation"]["allBoundariesReproduced"],
        "status": result["synthesis"]["status"], "exploratoryBands": [item["bandHz"] for item in result["synthesis"]["bandResponses"]],
        "candidates": [{"frequencyHz": item["frequencyHz"], "normalizedAmplitudes": [point["normalizedAmplitude"] for point in item["points"]]} for item in result["synthesis"]["candidates"]]}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
