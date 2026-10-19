"""Validate cloud native captures and import only server-selected complete files."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import uuid

import numpy as np

from .storage import HEADER, MAGIC, RECORD, RecordingStore, atomic_json, recording_rssi_stride
from .waveform import WaveformReader

CHUNK = re.compile(r"chunk-[0-9]{8}\.bin$")
CAPTURE = re.compile(r"[a-f0-9]{32}$")
TELEMETRY = "turntable.jsonl"
SAMPLES = np.dtype([("index", "<u8"), ("raw", "<i4"), ("value", "<f8"),
                    ("rssiRaw", "<i4"), ("rssi", "<f4"), ("flags", "u1")])
assert SAMPLES.itemsize == RECORD.size


def selected_directory(value, complete=False):
    root = Path(os.environ.get("BLADE_CAPTURE_DATA_DIR") or Path(__file__).resolve().parents[3] / ".data/web-captures").resolve()
    directory = Path(str(value))
    if (directory.is_symlink() or directory.parent.is_symlink() or
            directory.name not in (("complete",) if complete else ("incoming", "complete")) or
            not CAPTURE.fullmatch(directory.parent.name) or directory.parent.parent.resolve() != root or
            directory.resolve() != root / directory.parent.name / directory.name):
        raise ValueError("采集数据目录无效。")
    return directory


def read_json(file):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 512 * 1024:
        raise ValueError("采集元数据文件无效。")
    value = json.loads(file.read_text("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("采集元数据必须为对象。")
    return value


def validate_telemetry(directory, manifest, files):
    """Validate streamed host observations; these are not hardware-synced samples."""
    turntable = manifest.get("turntable")
    details = turntable.get("telemetry") if isinstance(turntable, dict) else None
    item = next((item for item in files if item.get("name") == TELEMETRY), None)
    if details is None and item is None and (not turntable or manifest.get("pointCycle")):
        # Point-cycle records can contain angle/point metadata without a motion log.
        return
    if (not isinstance(details, dict) or not item or details.get("file") != TELEMETRY or
            not isinstance(details.get("events"), int) or isinstance(details["events"], bool) or details["events"] < 1 or
            details.get("sha256") != item.get("sha256")):
        raise ValueError("转盘遥测清单、事件数量或摘要与记录不符。")

    def bounded(value, depth=0):
        if depth > 12:
            raise ValueError("转盘遥测嵌套过深。")
        if value is None or isinstance(value, bool):
            return
        if isinstance(value, (int, float)) and math.isfinite(value):
            return
        if isinstance(value, str) and len(value) <= 8192:
            return
        if isinstance(value, list) and len(value) <= 2048:
            for child in value:
                bounded(child, depth + 1)
            return
        if isinstance(value, dict) and len(value) <= 128:
            for key, child in value.items():
                if key in ("__proto__", "constructor", "prototype"):
                    raise ValueError("转盘遥测字段无效。")
                bounded(child, depth + 1)
            return
        raise ValueError("转盘遥测包含无效数值或超出大小限制。")

    count, previous = 0, -1.0
    with (directory / TELEMETRY).open("rb") as stream:
        while line := stream.readline(256 * 1024 + 1):
            if len(line) > 256 * 1024 or not line.endswith(b"\n"):
                raise ValueError("转盘遥测行过大或未完整保存。")
            try:
                event = json.loads(line)
                bounded(event)
            except (ValueError, RecursionError, UnicodeError, OverflowError) as error:
                raise ValueError("转盘遥测 JSON 行无效。") from error
            if (not isinstance(event, dict) or not isinstance(event.get("event"), str) or not 1 <= len(event["event"]) <= 128 or
                    any(not isinstance(event.get(key), (int, float)) or isinstance(event[key], bool) or not math.isfinite(event[key])
                        for key in ("hostTime", "elapsedSeconds")) or event["elapsedSeconds"] < previous or event["elapsedSeconds"] < 0):
                raise ValueError("转盘遥测事件或观察时间无效。")
            previous = event["elapsedSeconds"]
            count += 1
    if count != details["events"]:
        raise ValueError("转盘遥测事件总数与记录不符。")


def validate_capture(value):
    directory = selected_directory(value)
    transfer = read_json(directory / "transfer.json")
    manifest = read_json(directory / "manifest.json")
    files = transfer.get("files")
    if not isinstance(files, list) or not files or len(files) > 4096:
        raise ValueError("原始文件清单无效。")
    if manifest.get("status") != "complete" or manifest.get("unit") != "m/s" or manifest.get("format") != "BLADEV01/<QidifB":
        raise ValueError("原始采集记录尚未完整保存或格式无效。")
    source = manifest.get("source")
    if source not in ("simulation", "polytec_ivs500") or (source == "simulation" and not isinstance(manifest.get("simulation"), dict)):
        raise ValueError("数据来源或模拟标记无效。")
    rate, origin = manifest.get("sampleRate"), manifest.get("sampleOrigin")
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not math.isfinite(rate) or rate <= 0:
        raise ValueError("原始采样率无效。")
    if not isinstance(origin, (int, float)) or isinstance(origin, bool) or not math.isfinite(origin):
        raise ValueError("原始时间起点无效。")
    rssi_stride = recording_rssi_stride(manifest)
    names, chunks = set(), []
    for item in files:
        name = item.get("name", "")
        if name in names or not (CHUNK.fullmatch(name) or name in ("unpaired-rssi.bin", TELEMETRY)):
            raise ValueError("原始文件名重复或无效。")
        names.add(name)
        file = directory / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size != item.get("bytes"):
            raise ValueError("原始文件缺失或大小不符。")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != item.get("sha256"):
            raise ValueError("原始文件 SHA-256 校验失败。")
        if CHUNK.fullmatch(name):
            chunks.append(file)
    if set(p.name for p in directory.iterdir()) != names | {"manifest.json", "transfer.json"}:
        raise ValueError("采集目录含未完成或清单之外的文件。")
    chunks.sort()
    if [p.name for p in chunks] != [f"chunk-{i:08d}.bin" for i in range(len(chunks))] or len(chunks) != manifest.get("chunks"):
        raise ValueError("原始分块序号不连续或数量不符。")
    count = overrange = missing = 0
    for file in chunks:
        with file.open("rb") as stream:
            header = stream.read(HEADER.size)
            if len(header) != HEADER.size or HEADER.unpack(header) != (MAGIC, rate, origin, count):
                raise ValueError("原始分块头与采集记录不一致。")
            while block := stream.read(RECORD.size * 8192):
                if len(block) % RECORD.size:
                    raise ValueError("原始分块包含不完整样本。")
                samples = np.frombuffer(block, dtype=SAMPLES)
                flags = samples["flags"]
                if (not np.array_equal(samples["index"], np.arange(count, count + len(samples), dtype=np.uint64)) or
                        not np.isfinite(samples["value"]).all() or np.any(flags & 252) or
                        not np.isfinite(samples["rssi"][flags & 2 != 0]).all() or
                        np.any(((flags & 2) != 0) & (samples["index"] % rssi_stride != 0))):
                    raise ValueError("原始样本序号、数值或状态无效。")
                count += len(samples)
                overrange += int(np.count_nonzero(flags & 1))
                missing += int(np.count_nonzero(flags & 2 == 0))
    unpaired = 0
    if "unpaired-rssi.bin" in names:
        with (directory / "unpaired-rssi.bin").open("rb") as stream:
            last_start = -1
            while header := stream.read(16):
                if len(header) != 16:
                    raise ValueError("未配对 RSSI 分块头不完整。")
                start, amount = struct.unpack("<QQ", header)
                if start <= last_start or start >= count or amount < 1 or amount > 100_000_000:
                    raise ValueError("未配对 RSSI 序号或数量无效。")
                last_start = start
                remaining = amount
                while remaining:
                    size = min(remaining, 8192)
                    block = stream.read(size * 8)
                    if len(block) != size * 8 or any(not math.isfinite(v) for _raw, v in struct.iter_unpack("<if", block)):
                        raise ValueError("未配对 RSSI 数据不完整或数值无效。")
                    remaining -= size
                unpaired += amount
    for key, actual in (("samples", count), ("overrangeSamples", overrange), ("missingRssiSamples", missing), ("unpairedRssiSamples", unpaired)):
        if manifest.get(key, 0) != actual:
            raise ValueError(f"{key} 与原始数据不一致。")
    if count < 1:
        raise ValueError("不能上传空采集记录。")
    validate_telemetry(directory, manifest, files)
    return manifest


class CaptureStore:
    """Read-only adapter: never rebuild an index or recover cloud source files."""
    def __init__(self, directory):
        self.path = directory
        self.manifest = read_json(directory / "manifest.json")

    def directory(self, recording_id):
        if recording_id != self.manifest["id"]:
            raise ValueError("采集记录编号不匹配。")
        return self.path

    def _read_manifest(self, _directory):
        return self.manifest

    def chunks(self, _directory):
        return sorted(p for p in self.path.iterdir() if CHUNK.fullmatch(p.name) and p.is_file() and not p.is_symlink())


def capture_waveform(value, start=0, end=None):
    store = CaptureStore(selected_directory(value, complete=True))
    if store.manifest.get("status") != "complete":
        raise ValueError("采集记录尚未完整上传。")
    if isinstance(start, bool) or not isinstance(start, int) or start < 0 or (end is not None and (isinstance(end, bool) or not isinstance(end, int) or end <= start)):
        raise ValueError("波形样本区间无效。")
    return WaveformReader(store).read(store.manifest["id"], start, end)


def import_capture(store: RecordingStore, value):
    source = selected_directory(value, complete=True)
    # Only complete/ is reachable here; its atomic publication follows full
    # SHA/native validation, and the upload API never modifies completed files.
    manifest = read_json(source / "manifest.json")
    if manifest.get("status") != "complete":
        raise ValueError("采集记录尚未完整上传。")
    capture_id = source.parent.name
    target_id = hashlib.sha256(("cloud-capture:" + capture_id).encode()).hexdigest()[:32]
    destination = store.directory(target_id)
    if destination.exists():
        previous = store._read_manifest(destination)
        if previous.get("cloudCaptureId") != capture_id or previous.get("status") != "complete":
            raise ValueError("分析记录编号冲突。")
        return {"recording": previous}
    if len(store.list()) >= 128:
        raise ValueError("当前分析工作区达到 128 条记录上限。")
    temporary = store.root / (".capture-import-" + uuid.uuid4().hex)
    temporary.mkdir(mode=0o700)
    try:
        transfer = read_json(source / "transfer.json")
        for item in transfer["files"]:
            name = item["name"]
            if not (CHUNK.fullmatch(name) or name in ("unpaired-rssi.bin", TELEMETRY)):
                raise ValueError("原始文件名无效。")
            original = source / name
            if original.is_symlink() or not original.is_file() or original.stat().st_size != item["bytes"]:
                raise ValueError("原始文件缺失或大小不符。")
            try:
                os.link(original, temporary / name)
            except OSError as error:
                # Cross-volume and filesystems without hardlinks still work.
                if error.errno not in (18, 1, 13, 95):
                    raise
                shutil.copyfile(original, temporary / name)
        imported = {**manifest, "id": target_id, "cloudCaptureId": capture_id,
                    "sourceRecordingId": manifest.get("sourceRecordingId") or manifest["id"],
                    "sourceDataPreserved": True, "sourceQuantity": "velocity", "sourceUnit": "m/s",
                    "conversion": "原生采集样本，未重采样或修改数值"}
        atomic_json(temporary / "manifest.json", imported)
        os.rename(temporary, destination)
        store.update_index(imported)
        return {"recording": imported}
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
