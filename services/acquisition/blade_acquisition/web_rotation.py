"""User-scoped, one-shot Web analysis worker; never connects to device hardware."""
from __future__ import annotations

import base64
import csv
import gzip
import itertools
import shutil
import hashlib
import io
import json
import math
import re
import sys
import time
import zipfile
from collections import Counter, deque
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

import numpy as np

from .receiver import Batch
from .rotation import RotationRequest, calculate_rotation
from .storage import RecordingStore, atomic_json, recording_rssi_stride

MAX_FILE = 16 * 1024 * 1024
MAX_SAMPLES = 1_000_000
MAX_TOTAL = 2_000_000
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
HEADER_UNITS = {
    "velocity_m_s": ("velocity", "m/s", 1), "velocity_mm_s": ("velocity", "mm/s", 0.001),
    "displacement_m": ("displacement", "m", 1), "displacement_mm": ("displacement", "mm", 0.001),
    "displacement_um": ("displacement", "μm", 1e-6),
}


def xml(data: bytes):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("工作簿不支持 DTD 或实体声明。")
    return ET.fromstring(data)


class CheckedXmlReader:
    def __init__(self, stream):
        self.stream, self.tail = stream, b""

    def read(self, size=-1):
        data = self.stream.read(size)
        probe = (self.tail + data).upper()
        if b"<!DOCTYPE" in probe or b"<!ENTITY" in probe:
            raise ValueError("工作簿不支持 DTD 或实体声明。")
        self.tail = data[-16:]
        return data


def workbook_tables(raw: bytes):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(entry.file_size for entry in entries) > 96 * 1024 * 1024:
            raise ValueError("工作簿解压后过大，请拆分数据。")
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            text_size, string_root = 0, None
            with archive.open("xl/sharedStrings.xml") as string_stream:
                for event, node in ET.iterparse(CheckedXmlReader(string_stream), events=("start", "end")):
                    if string_root is None:
                        string_root = node
                    if event != "end" or node.tag != "{" + NS["s"] + "}si":
                        continue
                    value = "".join(node.itertext())
                    text_size += len(value)
                    if len(strings) >= 250_000 or text_size > 16 * 1024 * 1024:
                        raise ValueError("工作簿共享文本过大，请移除无关内容或拆分文件。")
                    strings.append(value)
                    node.clear()
                    string_root.clear()
        for metadata_name in ("xl/workbook.xml", "xl/_rels/workbook.xml.rels"):
            if archive.getinfo(metadata_name).file_size > 2 * 1024 * 1024:
                raise ValueError("工作簿元数据过大，请移除无关内容或拆分文件。")
        relations = {node.attrib["Id"]: node.attrib["Target"] for node in xml(archive.read("xl/_rels/workbook.xml.rels"))}
        total_cells = 0
        for sheet in xml(archive.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS):
            rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = relations.get(rid, "")
            path = str(PurePosixPath(target.lstrip("/"))) if target.startswith("/") else str(PurePosixPath("xl") / target)
            if ".." in PurePosixPath(path).parts or not path.startswith("xl/"):
                raise ValueError("工作簿引用路径无效。")
            rows = []
            with archive.open(path) as sheet_stream:
                sheet_data = None
                for event, row in ET.iterparse(CheckedXmlReader(sheet_stream), events=("start", "end")):
                    if event == "start" and row.tag == "{" + NS["s"] + "}sheetData":
                        sheet_data = row
                    if event != "end" or row.tag != "{" + NS["s"] + "}row":
                        continue
                    values = []
                    for cell in row.findall("s:c", NS):
                        reference = re.match(r"([A-Z]+)", cell.attrib.get("r", ""))
                        if not reference:
                            raise ValueError("工作簿单元格地址无效。")
                        column = 0
                        for letter in reference[1]:
                            column = column * 26 + ord(letter) - 64
                        if column > 64:
                            continue
                        while len(values) < column:
                            values.append(None)
                        value = cell.find("s:v", NS)
                        text = value.text if value is not None else None
                        kind = cell.attrib.get("t")
                        if cell.find("s:f", NS) is not None:
                            # Cached formula values are not trustworthy raw measurements.
                            values[column - 1] = "FORMULA_NOT_SUPPORTED"
                        elif kind == "s" and text is not None:
                            values[column - 1] = strings[int(text)]
                        elif kind == "inlineStr":
                            inline = cell.find("s:is", NS)
                            values[column - 1] = "".join(inline.itertext()) if inline is not None else ""
                        else:
                            values[column - 1] = text
                    total_cells += len(values)
                    if total_cells > 4_000_000:
                        raise ValueError("XLSX 最多包含 400 万个数据单元格，请拆分文件。")
                    rows.append(values)
                    row.clear()
                    if sheet_data is not None:
                        sheet_data.clear()
                    if len(rows) > MAX_SAMPLES + 20:
                        raise ValueError("每个测点最多导入 100 万个样本。")
            yield sheet.attrib["name"], rows


def finite(value, label: str) -> float:
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        raise ValueError(f"{label}缺少数值；不跳过空行或补造样本。")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label}必须是数值。") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label}必须是有限数值。")
    return number


def imported_record_metadata(metadata: dict, samples: int, sample_rate: float, first_time: float) -> dict:
    """Restore exported identity without inventing a capture clock or sample alignment."""
    if not isinstance(metadata, dict):
        raise ValueError("CSV 导出元数据必须是对象。")

    def number(value, label, lower=None, upper=None, integer=False):
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or (integer and not isinstance(value, int)) or
                (lower is not None and value < lower) or (upper is not None and value > upper)):
            raise ValueError(f"{label}无效。")
        return value

    def text(value, label, length=120):
        if not isinstance(value, str) or not value.strip() or len(value) > length:
            raise ValueError(f"{label}无效。")
        return value

    def bounded(value, depth=0):
        if depth > 12:
            raise ValueError("点位元数据嵌套过深。")
        if value is None or isinstance(value, bool):
            return
        if isinstance(value, (int, float)) and math.isfinite(value):
            return
        if isinstance(value, str) and len(value) <= 8192:
            return
        if isinstance(value, list) and len(value) <= 2048:
            for item in value:
                bounded(item, depth + 1)
            return
        if isinstance(value, dict) and len(value) <= 128:
            for key, item in value.items():
                if key in ("__proto__", "prototype", "constructor"):
                    raise ValueError("点位元数据字段无效。")
                bounded(item, depth + 1)
            return
        raise ValueError("点位元数据包含无效值或超出大小限制。")

    bounded(metadata)
    result = {}
    for key in ("windFarm", "object", "turbine"):
        if key in metadata:
            if not isinstance(metadata[key], str) or len(metadata[key]) > 180:
                raise ValueError(f"{key} 无效。")
            result[key] = metadata[key]
    for key in ("sampleOrigin", "sourceSampleOrigin"):
        if key in metadata:
            number(metadata[key], "原采集时间起点")
    source_origin = metadata.get("sourceSampleOrigin", metadata.get("sampleOrigin"))
    if source_origin is not None:
        result["sourceSampleOrigin"] = source_origin
    if "sourceTimeStart" in metadata:
        number(metadata["sourceTimeStart"], "原始时间偏移", 0)
    for key in ("recordingId", "sourceRecordingId"):
        if key in metadata and (not isinstance(metadata[key], str) or not re.fullmatch(r"[a-f0-9]{32}", metadata[key])):
            raise ValueError("原采集记录编号无效。")
    if "recordingId" in metadata:
        result["sourceRecordingId"] = metadata.get("sourceRecordingId", metadata["recordingId"])
    for key in ("startedAt", "endedAt"):
        source_key = "source" + key[0].upper() + key[1:]
        if key in metadata:
            number(metadata[key], "原采集时间")
            result[source_key] = metadata[key]
        if source_key in metadata:
            result[source_key] = number(metadata[source_key], "原采集时间")
    for key in ("turntable", "deviceSettings", "sampling"):
        if key in metadata:
            if not isinstance(metadata[key], dict):
                raise ValueError(f"{key} 元数据必须是对象。")
            result[key] = json.loads(json.dumps(metadata[key], allow_nan=False))
    stride = recording_rssi_stride({**metadata, "sampleRate": sample_rate})
    if "rssiSampleStride" in metadata or "rssiSampleRate" in metadata:
        result.update(rssiSampleStride=stride, rssiSampleRate=sample_rate / stride)
    if "pointCycle" not in metadata:
        return result
    cycle = metadata["pointCycle"]
    if not isinstance(cycle, dict) or not cycle:
        raise ValueError("点位元数据 pointCycle 必须是对象。")
    # Gates reference the original full record, never a cropped or shifted CSV.
    if (number(metadata.get("samples"), "原始样本数量", 1, integer=True) != samples or
            not math.isclose(number(metadata.get("sampleRate"), "原始采样率", 1e-12), sample_rate, rel_tol=1e-4) or
            abs(first_time) > 1e-12 or abs(metadata.get("sourceTimeStart", 0)) > 1e-12):
        raise ValueError("带点位边界的 CSV 必须保留从 0 开始的完整原始样本。")
    mode = cycle.get("mode", "legacy")
    if mode not in ("automatic_stations", "legacy"):
        raise ValueError("点位采集模式无效。")
    if mode == "legacy" and any(key not in cycle for key in ("cycle", "pointIndex", "pointName")):
        raise ValueError("旧版点位记录缺少采集轮次或点位信息。")
    for key in ("collectionId", "sessionId"):
        if key in cycle and (not isinstance(cycle[key], str) or not re.fullmatch(r"[a-f0-9]{32}", cycle[key])):
            raise ValueError(f"点位 {key} 无效。")
    for key in ("bladeId", "radialPointId", "radialPointName", "pointId", "stationId", "pointName"):
        if key in cycle:
            text(cycle[key], f"点位 {key}")
    if "stationId" in cycle and "pointId" in cycle and cycle["stationId"] != cycle["pointId"]:
        raise ValueError("点位编号与点位编号不一致。")
    for key in ("stationIndex", "stationCount", "lapIndex", "cycle", "pointIndex", "cycles"):
        if key in cycle:
            number(cycle[key], f"点位 {key}", 1, 1_000_000, integer=True)
    if "stationIndex" in cycle and "stationCount" in cycle and cycle["stationIndex"] > cycle["stationCount"]:
        raise ValueError("点位序号超出点位总数。")
    if "radiusM" in cycle:
        number(cycle["radiusM"], "测点半径", 1e-12, 1000)
    if "azimuthDeg" in cycle:
        number(cycle["azimuthDeg"], "点位角", 0, 360)
        if cycle["azimuthDeg"] == 360:
            raise ValueError("点位角必须小于 360 度。")
    if "nominalPeriodSeconds" in cycle and cycle["nominalPeriodSeconds"] is not None:
        # Zero is an explicitly operator-driven pass, not a measured period or
        # a substitute RPM. Keep it when importing a full automatic-station record.
        number(cycle["nominalPeriodSeconds"], "叶轮周期", 0 if mode == "automatic_stations" else 1e-12)
    if mode == "automatic_stations":
        for key in ("sessionId", "bladeId", "radialPointId", "radiusM", "azimuthDeg", "stationIndex", "stationCount", "lapIndex"):
            if key not in cycle:
                raise ValueError(f"自动跟随记录缺少 {key}。")
        if cycle.get("identityVerified", False) is not False:
            raise ValueError("导入记录不能声明未经验证的叶片身份。")
    completion = cycle.get("completion")
    if completion is not None and completion not in ("confirmed_pass", "unconfirmed_pass", "missing_entry", "missing_exit", "signal_gap", "cancelled", "device_error"):
        raise ValueError("点位完成状态无效。")
    for key in ("entrySampleIndex", "exitSampleIndex"):
        if key in cycle:
            number(cycle[key], f"点位 {key}", 0, samples - 1, integer=True)
    handoff = cycle.get("handoff")
    if handoff is not None:
        if not isinstance(handoff, dict):
            raise ValueError("叶片进入离开边界无效。")
        keys = ("entrySampleIndex", "entryConfirmedSampleIndex", "exitSampleIndex", "exitConfirmedSampleIndex")
        for key in keys:
            if key in handoff:
                number(handoff[key], f"叶片边界 {key}", 0, samples - 1, integer=True)
        if all(key in handoff for key in keys):
            a, b, c, d = (handoff[key] for key in keys)
            if not a <= b < c <= d:
                raise ValueError("叶片进入离开样本边界顺序无效。")
        elif completion == "confirmed_pass":
            raise ValueError("已确认通过的记录缺少完整进入离开边界。")
    elif completion == "confirmed_pass":
        raise ValueError("已确认通过的记录缺少进入离开边界。")
    result["pointCycle"] = json.loads(json.dumps(cycle, allow_nan=False))
    return result


def write_import_rows(writer, rows, rate, origin, stride=1):
    """Keep sparse RSSI slots sparse, including missing expected observations."""
    if (writer.manifest["samples"] % stride or
            any(row[1] is not None for index, row in enumerate(rows) if index % stride)):
        raise ValueError("RSSI 样本位置与原采样间隔不一致。")
    offset = 0
    while offset < len(rows):
        present = rows[offset][1] is not None
        end = min(offset + stride, len(rows))
        while end < len(rows) and (rows[end][1] is not None) == present:
            end = min(end + stride, len(rows))
        values = [row[0] for row in rows[offset:end]]
        rssi = [row[1] for row in rows[offset:end:stride]] if present else []
        writer.write(Batch(writer.manifest["samples"], rate, origin, [0] * len(values), values,
                           [0] * len(rssi), rssi, [row[2] for row in rows[offset:end]], stride))
        offset = end


def parse_table(name: str, rows: list, options: dict):
    header_index = next((i for i, row in enumerate(rows[:20]) if "time_s" in [str(v).strip().lower() for v in row] or "time" in [str(v).strip().lower() for v in row]), None)
    if header_index is None:
        return None
    headers = [str(v or "").strip().lower() for v in rows[header_index]]
    if len([h for h in headers if h]) != len(set(h for h in headers if h)):
        raise ValueError(f"{name} 存在重复列名。")
    time_key = "time_s" if "time_s" in headers else "time"
    # A qualified velocity column takes precedence over displacement from the same file.
    value_key = next((key for key in HEADER_UNITS if key in headers), None)
    if value_key:
        quantity, unit, factor = HEADER_UNITS[value_key]
    elif "value" in headers:
        value_key = "value"
        quantity, unit = options.get("quantity"), options.get("unit")
        factors = {("velocity", "m/s"): 1, ("velocity", "mm/s"): 0.001,
                   ("displacement", "m"): 1, ("displacement", "mm"): 0.001,
                   ("displacement", "μm"): 1e-6}
        if (quantity, unit) not in factors:
            raise ValueError(f"{name} 的 value 列缺少物理量和单位，请在导入时明确选择。")
        factor = factors[(quantity, unit)]
    else:
        raise ValueError(f"{name} 必须包含带单位的速度/位移列，或 value 列并明确指定单位。")
    body = rows[header_index + 1:]
    while body and all(v is None or str(v).strip() == "" for v in body[-1]):
        body.pop()
    if not 64 <= len(body) <= MAX_SAMPLES:
        raise ValueError(f"{name} 需要 64～1000000 个连续样本。")
    metadata = options.get("metadata", {})
    if metadata.get("samples") is not None and metadata["samples"] != len(body):
        raise ValueError(f"{name} 样本数与导出元数据不符，文件可能未完整导出。")
    columns = {key: i for i, key in enumerate(headers) if key}
    get = lambda row, key: row[columns[key]] if columns[key] < len(row) else None
    times = np.array([finite(get(row, time_key), f"{name} 第 {i + header_index + 2} 行时间") for i, row in enumerate(body)])
    intervals = np.diff(times)
    dt = float(np.median(intervals))
    if dt <= 0 or not np.all(np.abs(intervals - dt) <= max(dt * 1e-4, 1e-10)):
        raise ValueError(f"{name} 时间轴不连续或非等间隔；请先检查缺失样本。")
    if metadata.get("sampleRate") is not None:
        source_rate = finite(metadata["sampleRate"], "元数据采样率")
        if source_rate <= 0 or not math.isclose(source_rate, 1 / dt, rel_tol=1e-4):
            raise ValueError(f"{name} 时间轴与元数据采样率不一致。")
        dt = 1 / source_rate
    values = np.array([finite(get(row, value_key), f"{name} 第 {i + header_index + 2} 行信号") * factor for i, row in enumerate(body)])
    if quantity == "displacement":
        values = np.gradient(values, dt, edge_order=2)
    auxiliary = {}
    for key in ("rpm", "rotor_angle_deg", "blade_id", "keyphase", "laser_hit", "visibility", "rssi_percent", "quality", "overrange", "sample"):
        if key in columns:
            auxiliary[key] = [get(row, key) for row in body]
    if "sample" in auxiliary:
        indices = [finite(value, "样本序号") for value in auxiliary["sample"]]
        if any(b - a != 1 for a, b in zip(indices, indices[1:])):
            raise ValueError(f"{name} 样本序号不连续。")
    rssi = [None if v is None or str(v).strip() == "" else finite(v, "RSSI") for v in auxiliary.get("rssi_percent", [])]
    if any(v is not None and not 0 <= v <= 100 for v in rssi):
        raise ValueError(f"{name} RSSI_percent 必须在 0～100 之间。")
    record_metadata = imported_record_metadata(metadata, len(body), 1 / dt, float(times[0]))
    stride = record_metadata.get("rssiSampleStride", 1)
    if any(value is not None for index, value in enumerate(rssi) if index % stride):
        raise ValueError("RSSI 样本位置与原采样间隔不一致。")
    rpms = [finite(v, "RPM") for v in auxiliary.get("rpm", [])]
    if any(v <= 0 for v in rpms):
        raise ValueError(f"{name} RPM 必须为正数。")
    position_match = re.search(r"xL([0-9]+(?:\.[0-9]+)?)", name, re.I)
    position = finite(metadata["position"], "位置") if metadata.get("position") is not None else float(position_match[1]) if position_match else None
    if position is not None and not 0 <= position <= 1:
        raise ValueError(f"{name} 测点位置 x/L 超出 0～1。")
    quality = dict(Counter(str(value or "UNSPECIFIED") for value in auxiliary.get("quality", [])))
    if len(quality) > 64 or any(len(label) > 120 for label in quality):
        raise ValueError("质量标签最多 64 种，每种最多 120 个字符。")
    summary = " ".join(str(v or "") for row in rows[:header_index] for v in row).lower()
    simulated = options.get("source") == "simulation" or "simulation" in summary or "模拟" in summary or metadata.get("source") == "simulation" or bool(metadata.get("simulation"))
    device_source = metadata.get("source") in ("device", "polytec_ivs500", "measured")
    return {**record_metadata, "name": str(metadata.get("name") or name)[:180], "point": str(metadata.get("point") or name)[:120], "values": values, "rssi": rssi, "sampleRate": 1 / dt,
            "source": "simulation" if simulated else "measured" if device_source else options.get("source", "offline"), "position": position,
            "sourceMetadata": metadata, "simulation": metadata.get("simulation"),
            "rpm": float(np.median(rpms)) if rpms else metadata.get("rpm"),
            "rpmRange": [min(rpms), max(rpms)] if rpms else None,
            "sourceQuantity": quantity, "sourceUnit": unit, "sourceTimeStart": float(times[0]),
            "conversion": "位移经二阶边界差分转换为速度（中心差分内点）" if quantity == "displacement" else f"{unit} 换算为 m/s",
            "qualityCounts": quality, "auxiliary": auxiliary,
            "overrange": [str(value).strip().lower() in ("1", "true", "overrange") for value in auxiliary.get("overrange", [False] * len(body))]}


def import_csv_stream(store: RecordingStore, input_file: Path, filename: str, options: dict):
    """Bound memory to a batch while importing up to eight million CSV samples."""
    if input_file.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("CSV / CSV.GZ 压缩文件不能超过 128 MB。")
    if len(store.list()) >= 128:
        raise ValueError("当前账号已达到 128 条分析记录上限，请先归档数据。")
    with input_file.open("rb") as hash_stream:
        source_hash = hashlib.file_digest(hash_stream, "sha256").hexdigest()
    compressed = filename.lower().endswith(".csv.gz")
    metadata, writer = {}, None
    source_name = filename[:-7] if compressed else Path(filename).stem
    with input_file.open("rb") as original:
        stream = gzip.GzipFile(fileobj=original) if compressed else original
        decompressed = 0

        def lines():
            nonlocal decompressed
            while True:
                raw = stream.readline(64 * 1024 + 1)
                if not raw:
                    return
                decompressed += len(raw)
                if len(raw) > 64 * 1024 or decompressed > 512 * 1024 * 1024:
                    raise ValueError("CSV 单行超过 64 KB 或解压后超过 512 MB。")
                yield raw.decode("utf-8-sig")

        line_iterator = iter(lines())
        first = next(line_iterator, "")
        if first.startswith("# BladeVMS "):
            metadata = json.loads(first[len("# BladeVMS "):])
            if not isinstance(metadata, dict) or metadata.get("format") != "blade-vms-csv-1":
                raise ValueError("不支持的 BladeVMS CSV 导出格式。")
            first = next(line_iterator, "")
        reader = csv.reader(itertools.chain([first], line_iterator))
        headers = [value.strip().lower() for value in next(reader, [])]
        if len(headers) > 64 or len(headers) != len(set(headers)):
            raise ValueError("CSV 列数超过 64 或包含重复列名。")
        time_key = "time_s" if "time_s" in headers else "time" if "time" in headers else None
        value_key = next((key for key in HEADER_UNITS if key in headers), None)
        if value_key:
            quantity, unit, factor = HEADER_UNITS[value_key]
        elif "value" in headers:
            value_key = "value"
            quantity, unit = options.get("quantity"), options.get("unit")
            factors = {("velocity", "m/s"): 1, ("velocity", "mm/s"): 0.001,
                       ("displacement", "m"): 1, ("displacement", "mm"): 0.001, ("displacement", "μm"): 1e-6}
            if (quantity, unit) not in factors:
                raise ValueError("value 列缺少物理量和单位，请在导入时明确选择。")
            factor = factors[(quantity, unit)]
        else:
            raise ValueError("CSV 缺少带单位的速度/位移列或明确单位的 value 列。")
        if not time_key:
            raise ValueError("CSV 缺少 time_s 时间列（秒）。")
        columns = {key: index for index, key in enumerate(headers)}
        source = options.get("source", "offline")
        if source not in ("offline", "simulation", "measured"):
            raise ValueError("数据来源无效。")
        if metadata.get("source") == "simulation" or bool(metadata.get("simulation")):
            source = "simulation"
        elif source != "simulation" and metadata.get("source") in ("device", "polytec_ivs500", "measured"):
            source = "measured"
        position_match = re.search(r"xL([0-9]+(?:\.[0-9]+)?)", source_name, re.I)
        position = finite(metadata["position"], "位置") if metadata.get("position") is not None else float(position_match[1]) if position_match else None
        if position is not None and not 0 <= position <= 1:
            raise ValueError("测点位置 x/L 必须在 0～1 之间。")
        count, written, first_time, dt, rate = 0, 0, None, None, None
        record_metadata, stride, batch_limit = {}, 1, 16384
        origin = time.time()
        pending, batch = deque(maxlen=3), []
        quality, rpms = Counter(), [None, None]
        sample_first = None

        def flush():
            nonlocal written
            write_import_rows(writer, batch, rate, origin, stride)
            written += len(batch)
            batch.clear()

        def emit(row, value):
            if not math.isfinite(value):
                raise ValueError("单位换算后出现无效数值。")
            batch.append((value, row[1], row[2]))
            if len(batch) >= batch_limit:
                flush()

        try:
            for row in reader:
                if len(row) != len(headers):
                    raise ValueError(f"CSV 第 {count + 2} 行列数不一致或为空行，未跳过缺失样本。")
                cell = lambda key: row[columns[key]]
                timestamp = finite(cell(time_key), "时间")
                value = finite(cell(value_key), "信号") * factor
                rssi = finite(cell("rssi_percent"), "RSSI") if "rssi_percent" in columns and cell("rssi_percent").strip() else None
                if rssi is not None and not 0 <= rssi <= 100:
                    raise ValueError("RSSI_percent 必须在 0～100 之间。")
                flag = cell("overrange").strip().lower() if "overrange" in columns else "0"
                if flag not in ("0", "1", "true", "false", "overrange"):
                    raise ValueError("overrange 必须使用 0/1 或 true/false。")
                point = (value, rssi, flag in ("1", "true", "overrange"))
                if "quality" in columns:
                    label = cell("quality") or "UNSPECIFIED"
                    if len(label) > 120 or (label not in quality and len(quality) >= 64):
                        raise ValueError("质量标签最多 64 种，每种最多 120 个字符。")
                    quality[label] += 1
                if "rpm" in columns:
                    rpm = finite(cell("rpm"), "RPM")
                    if rpm <= 0:
                        raise ValueError("RPM 必须为正数。")
                    rpms = [rpm if rpms[0] is None else min(rpms[0], rpm), rpm if rpms[1] is None else max(rpms[1], rpm)]
                if "sample" in columns:
                    sample = finite(cell("sample"), "样本序号")
                    if sample_first is None:
                        sample_first = sample
                    if sample != sample_first + count:
                        raise ValueError("样本序号不连续。")
                if first_time is None:
                    first_time = timestamp
                elif dt is None:
                    dt = timestamp - first_time
                    if dt <= 0:
                        raise ValueError("时间轴必须单调递增且等间隔。")
                    rate = 1 / dt
                    if metadata.get("sampleRate") is not None:
                        actual = finite(metadata["sampleRate"], "元数据采样率")
                        if actual <= 0 or not math.isclose(actual, rate, rel_tol=1e-4):
                            raise ValueError("时间轴与元数据采样率不一致。")
                        rate, dt = actual, 1 / actual
                    # Validate declared sample-index gates before creating any record, then recheck the final count.
                    record_metadata = imported_record_metadata(metadata, metadata.get("samples", 2), rate, first_time)
                    stride = record_metadata.get("rssiSampleStride", 1)
                    batch_limit = max(stride, (16384 // stride) * stride)
                    writer = store.create({**record_metadata, "name": str(metadata.get("name") or source_name)[:180], "point": str(metadata.get("point") or source_name)[:120],
                        "source": source, "sourceFile": filename, "sourceSha256": source_hash, "sourceDataPreserved": True,
                        "sourceQuantity": quantity, "sourceUnit": unit, "sourceTimeStart": first_time, "sourceMetadata": metadata,
                        "simulation": metadata.get("simulation"), "position": position, "rpm": metadata.get("rpm"),
                        "conversion": "位移经二阶边界差分转换为速度（中心差分内点）" if quantity == "displacement" else f"{unit} 换算为 m/s",
                        "object": record_metadata.get("object", ""), "turbine": record_metadata.get("turbine", "")})
                    writer.ready(rate, origin)
                if dt is not None and abs(timestamp - (first_time + count * dt)) > max(dt * 1e-4, 1e-9):
                    raise ValueError(f"第 {count + 1} 个样本时间轴不连续或非等间隔。")
                count += 1
                if count > 8_000_000:
                    raise ValueError("CSV 单测点最多导入 800 万个连续样本。")
                pending.append(point)
                if quantity == "velocity":
                    if count == 2:
                        emit(pending[0], pending[0][0])
                    if count >= 2:
                        emit(point, value)
                elif count == 3:
                    a, b, c = pending
                    emit(a, (-3 * a[0] + 4 * b[0] - c[0]) / (2 * dt))
                    emit(b, (c[0] - a[0]) / (2 * dt))
                elif count > 3:
                    a, b, c = pending
                    emit(b, (c[0] - a[0]) / (2 * dt))
            if count < 64:
                raise ValueError("CSV 至少需要 64 个连续样本。")
            if metadata.get("samples") is not None and metadata["samples"] != count:
                raise ValueError("样本数与导出元数据不符，文件可能未完整导出。")
            imported_record_metadata(metadata, count, rate, first_time)
            if quantity == "displacement":
                a, b, c = pending
                emit(c, (3 * c[0] - 4 * b[0] + a[0]) / (2 * dt))
            flush()
            source_dir = store.root.parent / "sources"
            source_dir.mkdir(exist_ok=True)
            destination = source_dir / f"{source_hash}{'.csv.gz' if compressed else '.csv'}"
            if not destination.exists():
                shutil.copyfile(input_file, destination)
            writer.manifest.update(qualityCounts=dict(quality), rpmRange=rpms if rpms[0] is not None else None)
            if rpms[0] is not None:
                writer.manifest["rpm"] = (rpms[0] + rpms[1]) / 2
            writer.finish(None)
            return {"recordings": [writer.manifest], "sourceSha256": source_hash}
        except Exception:
            if writer is not None:
                writer.finish("离线文件未通过完整性校验，导入未完成。")
            raise


def import_file(store: RecordingStore, payload: dict):
    filename = Path(str(payload.get("filename", ""))).name[:180]
    if payload.get("inputFile"):
        input_file = Path(payload["inputFile"])
        if input_file.is_symlink() or input_file.resolve().parent != store.root.parent or not input_file.name.startswith(".upload-"):
            raise ValueError("上传临时文件无效。")
        if filename.lower().endswith((".csv", ".csv.gz")):
            return import_csv_stream(store, input_file, filename, payload.get("options", {}))
        if input_file.stat().st_size > MAX_FILE:
            raise ValueError("XLSX 文件不能超过 16 MB。")
        raw = input_file.read_bytes()
    else:
        raw = base64.b64decode(payload.get("bytes", ""), validate=True)
    if not raw or len(raw) > MAX_FILE:
        raise ValueError("单文件大小须在 1 字节至 16 MB 之间。")
    filename = Path(str(payload.get("filename", ""))).name[:180]
    suffix = Path(filename).suffix.lower()
    options = payload.get("options", {})
    if options.get("source", "offline") not in ("offline", "simulation", "measured"):
        raise ValueError("数据来源无效。")
    if suffix == ".xlsx":
        tables = workbook_tables(raw)
    elif suffix == ".csv":
        content = raw.decode("utf-8-sig")
        if content.startswith("# BladeVMS "):
            first, separator, content = content.partition("\n")
            if not separator or len(first) > 64 * 1024:
                raise ValueError("CSV 导出元数据无效。")
            metadata = json.loads(first[len("# BladeVMS "):])
            if not isinstance(metadata, dict) or metadata.get("format") != "blade-vms-csv-1":
                raise ValueError("不支持的 BladeVMS CSV 导出格式。")
            options = {**options, "metadata": metadata}
        tables = [(Path(filename).stem, list(csv.reader(io.StringIO(content))))]
    else:
        raise ValueError("支持 .xlsx 和 UTF-8 .csv 文件。")
    points = []
    for name, rows in tables:
        point = parse_table(name, rows, options)
        if point is not None:
            points.append(point)
        if len(points) > 8 or sum(len(p["values"]) for p in points) > MAX_TOTAL:
            raise ValueError("每次最多导入 8 个测点、合计 200 万个样本。")
    if not points:
        raise ValueError("未找到含 time_s + velocity_m_s（或位移/明确单位 value）的数据表。")
    if len(store.list()) + len(points) > 128:
        raise ValueError("当前账号已达到 128 条分析记录上限，请由管理员归档数据后再导入。")
    # All tables are validated before creating records. Keep source bytes and quality columns.
    source_hash = hashlib.sha256(raw).hexdigest()
    source_dir = store.root.parent / "sources"
    source_dir.mkdir(exist_ok=True)
    source_path = source_dir / f"{source_hash}{suffix}"
    if not source_path.exists():
        source_path.write_bytes(raw)
    imported = []
    for point in points:
        values, rssi = point.pop("values"), point.pop("rssi")
        auxiliary, overrange = point.pop("auxiliary"), point.pop("overrange")
        count = len(values)
        writer = store.create({**point, "sourceFile": filename, "sourceSha256": source_hash,
                               "sourceDataPreserved": True, "windFarm": point.get("windFarm", ""), "object": point.get("object", ""), "turbine": point.get("turbine", "")})
        try:
            origin = time.time()
            writer.ready(point["sampleRate"], origin)
            stride = point.get("rssiSampleStride", 1)
            batch_limit = max(stride, (16384 // stride) * stride)
            start = 0
            while start < count:
                end = min(start + batch_limit, count)
                rows = [(float(values[index]), rssi[index] if rssi else None, overrange[index]) for index in range(start, end)]
                write_import_rows(writer, rows, point["sampleRate"], origin, stride)
                start = end
            atomic_json(writer.directory / "source-columns.json", {"sourceTimeStart": point["sourceTimeStart"], "columns": auxiliary})
            writer.finish(None)
        except Exception:
            writer.finish("离线数据导入中断；请重新导入。")
            raise
        imported.append(writer.manifest)
    return {"recordings": imported, "sourceSha256": source_hash}


def dispatch(root: Path, payload: dict):
    action = payload.get("action")
    if action not in ("recordings", "import", "rotation", "blade-passes", "capture-validate", "capture-waveform", "capture-import"):
        raise ValueError("不支持的 Web 分析操作。")
    if action.startswith("capture-"):
        from .native_capture import validate_capture, capture_waveform, import_capture
        if action == "capture-validate":
            return {"recording": validate_capture(payload.get("captureDirectory"))}
        if action == "capture-waveform":
            return capture_waveform(payload.get("captureDirectory"), payload.get("start", 0), payload.get("end"))
        return import_capture(RecordingStore(root / "recordings"), payload.get("captureDirectory"))
    store = RecordingStore(root / "recordings")
    if action == "recordings":
        return {"recordings": store.list()}
    if action == "import":
        return import_file(store, payload)
    if action == "blade-passes":
        parameters = payload.get("parameters")
        if isinstance(parameters, dict) and "synthesis" in parameters:
            from .blade_synthesis import reconstruct_blade_passes
            return reconstruct_blade_passes(store, parameters)
        from .blade_passes import analyze_blade_passes
        return analyze_blade_passes(store, parameters)
    config = RotationRequest.model_validate(payload.get("parameters"))
    manifests = [store._read_manifest(store.directory(record_id)) for record_id in config.recordingIds]
    rates = [record.get("sampleRate") for record in manifests]
    if all(isinstance(rate, (int, float)) and math.isfinite(rate) and rate > 0 for rate in rates):
        maximum_order = min(rates) / 2 / (config.rpm / 60)
        if config.maxOrder >= maximum_order:
            raise ValueError(f"阶次谱上限必须小于 {maximum_order:.6g} 阶（最低原始采样率的奈奎斯特边界），请降低阶次上限或检查 RPM。")
    result = calculate_rotation(store, config)
    result["sources"] = [{key: record.get(key) for key in ("id", "name", "source", "sourceFile", "sourceSha256", "sourceUnit", "sourceQuantity", "conversion", "qualityCounts", "rpmRange", "sourceTimeStart")} for record in manifests]
    if any(record.get("source") == "simulation" for record in manifests):
        result["warnings"].append("本次输入包含模拟数据；分析结果仅用于调试验证，不作为实测结论。")
    if any(record.get("qualityCounts") for record in manifests):
        result["warnings"].append("导入保留全部质量标签及低回波样本；当前恒转速算法使用连续信号，没有按质量标签剔除样本。")
    if any(record.get("rpmRange") and record["rpmRange"][1] - record["rpmRange"][0] > 1e-6 for record in manifests):
        result["warnings"].append("输入 RPM 存在变化；本次仍按用户设置的恒定 RPM 计算，不能作为变转速阶次跟踪。")
    return result


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m blade_acquisition.web_rotation <user-data-root>")
    try:
        payload = json.loads(sys.stdin.buffer.read(24 * 1024 * 1024 + 1))
        result = dispatch(Path(sys.argv[1]), payload)
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False, allow_nan=False))
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "记录或数据文件不存在，请刷新后重试。"}, ensure_ascii=False))
        raise SystemExit(2)
    except OSError:
        print(json.dumps({"ok": False, "error": "数据文件读取或保存失败，请检查文件完整性和服务端存储。"}, ensure_ascii=False))
        raise SystemExit(2)
    except (ValueError, KeyError, EOFError, zipfile.BadZipFile, ET.ParseError, UnicodeDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)


if __name__ == "__main__":
    main()
