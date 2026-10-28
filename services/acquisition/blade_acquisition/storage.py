"""Append-only raw chunks + atomic manifest; SQLite is a rebuildable index only."""
from __future__ import annotations

import json
import copy
import math
import os
import re
import sqlite3
import struct
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any

import numpy as np

from .receiver import Batch

MAGIC = b"BLADEV01"
HEADER = struct.Struct("<8sddQ")  # magic, sample rate, epoch origin, first sample index
RECORD = struct.Struct("<QidifB")  # index, raw velocity, m/s, raw RSSI, RSSI %, flags
# Unaligned little-endian layout: byte-compatible with every existing BLADEV01 reader.
RECORD_DTYPE = np.dtype([("index", "<u8"), ("velocityRaw", "<i4"), ("velocity", "<f8"),
                         ("rssiRaw", "<i4"), ("rssi", "<f4"), ("flags", "u1")])
assert RECORD_DTYPE.itemsize == RECORD.size


def pack_records(batch: Batch) -> tuple[np.ndarray, int, int]:
    """Bulk conversion avoids a Python pack_into call for every 250 kHz sample."""
    count, stride = len(batch.values), batch.rssi_sample_stride
    data = np.zeros(count, dtype=RECORD_DTYPE)
    data["index"] = np.arange(batch.sample_start, batch.sample_start + count, dtype=np.uint64)
    data["velocityRaw"] = batch.velocity_raw
    data["velocity"] = batch.values
    data["flags"] = batch.overrange
    expected = (count + stride - 1) // stride
    paired = min(expected, len(batch.rssi))
    if paired:
        positions = slice(0, paired * stride, stride)
        data["rssiRaw"][positions] = batch.rssi_raw[:paired]
        data["rssi"][positions] = batch.rssi[:paired]
        data["flags"][positions] |= 2
    return data, count - paired, count - expected


ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
CHUNK_PATTERN = re.compile(r"^chunk-[0-9]{8}\.bin(?:\.part)?$")
DISPLAY_LIMIT = 2048

RECORDING_LIST_FIELDS = (
    "id", "name", "source", "windFarm", "object", "turbine", "point",
    "samples", "sampleRate", "startedAt", "endedAt", "status", "error", "unit",
    "sampleOrigin", "velocityRangeMps", "position", "rpm", "qualityCounts", "simulation", "captureSessionId", "sampling",
    "diagnosticOnly", "validMeasurement",
)
POINT_LIST_FIELDS = (
    "mode", "collectionId", "sessionId", "bladeId", "radialPointId", "radialPointName",
    "radiusM", "azimuthDeg", "stationIndex", "stationCount", "lapIndex", "identitySource",
    "identityVerified", "coverageKind", "completion", "passCompleteness", "completenessReason", "plannedStations", "nominalPeriodSeconds",
    "cycle", "pointIndex", "pointId", "pointName", "cycles", "dwellSeconds",
    "targetAxis1AngleDeg", "targetAxis2AngleDeg", "actualAngles", "recordedPort", "referenceSignature",
    "executionMode", "segmentedAutoMove", "segmentStepDeg", "totalStationCount", "segmentStationIds", "nextWaitPoint",
)


def normalize_recording_name(manifest: dict) -> dict:
    """Remove only the suffix added by older early-detection builds, without disk writes."""
    original = manifest.get("originalTaskName")
    if isinstance(original, str):
        return {**manifest, "name": original}
    name = manifest.get("name")
    cycle = manifest.get("pointCycle")
    evidence = cycle.get("diagnosticDetection") if isinstance(cycle, dict) else None
    suffix = " [未停稳判定测试]"
    if (manifest.get("diagnosticOnly") is True and isinstance(evidence, dict) and
            evidence.get("enabled") is True and isinstance(name, str) and name.endswith(suffix)):
        # Strip one application-added suffix, preserving a user's literal suffix.
        return {**manifest, "name": name[:-len(suffix)], "originalTaskName": name[:-len(suffix)]}
    return manifest


def normalize_recording_metadata(manifest: dict) -> dict:
    """Expose legacy early-pass evidence consistently, without rewriting raw files.

    Deferred early captures once omitted the summary fields but retained them in
    both handoff and diagnostic evidence. Recover only that known omission; an
    explicit unconfirmed result or missing/conflicting evidence stays unchanged.
    Diagnostic data never becomes a validated measurement here.
    """
    manifest = normalize_recording_name(manifest)
    cycle = manifest.get("pointCycle")
    if (not isinstance(cycle, dict) or cycle.get("completion") != "diagnostic_pass" or
            "passCompleteness" in cycle or
            cycle.get("recordPreparation") != "deferred_from_continuous_raw" or
            manifest.get("diagnosticOnly") is not True or manifest.get("validMeasurement") is not False):
        return manifest
    diagnostic = cycle.get("diagnosticDetection")
    handoff = cycle.get("handoff")
    trigger = diagnostic.get("trigger") if isinstance(diagnostic, dict) else None
    if (not isinstance(handoff, dict) or not isinstance(trigger, dict) or
            diagnostic.get("enabled") is not True or
            any(value.get("passCompleteness") != "confirmed" or
                value.get("sampleClock") != "continuous_session_raw" for value in (handoff, trigger)) or
            handoff.get("completenessReason") != trigger.get("completenessReason")):
        return manifest
    restored = {**cycle, "passCompleteness": "confirmed"}
    if "completenessReason" not in restored and isinstance(handoff.get("completenessReason"), str):
        restored["completenessReason"] = handoff["completenessReason"]
    return {**manifest, "pointCycle": restored}


def recording_summary(manifest: dict) -> dict:
    """List-only metadata; detail/export/upload retain full diagnostic evidence."""
    manifest = normalize_recording_metadata(manifest)
    result = {key: copy.deepcopy(manifest[key]) for key in RECORDING_LIST_FIELDS if key in manifest}
    for source, target in ((manifest, result), (manifest.get("sourceMetadata"), {})):
        if not isinstance(source, dict) or "pointCycle" not in source:
            continue
        cycle = source["pointCycle"]
        target["pointCycle"] = ({key: copy.deepcopy(cycle[key]) for key in POINT_LIST_FIELDS if key in cycle}
                                if isinstance(cycle, dict) else copy.deepcopy(cycle))
        if source is not manifest:
            result["sourceMetadata"] = target
    return result


def recording_list_page(records: list[dict], offset: int = 0, limit: int = 100,
                        *, max_bytes: int = 1_500_000) -> dict:
    """Bound each transport response without dropping records or stored motion evidence."""
    if offset < 0 or not 1 <= limit <= 100:
        raise ValueError("Invalid recording-list page")
    page = []
    # Reserve space for the envelope and separators, using UTF-8 bytes rather
    # than characters so non-ASCII labels cannot exceed the transport budget.
    used = 128
    for manifest in records[offset:offset + limit]:
        summary = recording_summary(manifest)
        size = len(json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if used + size > max_bytes:
            if not page:
                raise ValueError("单条记录的列表信息过大，请检查点位计划元数据")
            break
        page.append(summary)
        used += size
    end = offset + len(page)
    return {"recordings": page, "nextOffset": end if end < len(records) else None, "total": len(records)}


def empty_waveform() -> dict:
    return {"sampleRate": None, "unit": "m/s", "rssiUnit": "%", "sampleStart": 0,
            "sampleStride": 1, "values": [], "rssi": [], "overrange": []}


def recording_rssi_stride(manifest: dict) -> int:
    stride = manifest.get("rssiSampleStride", 1)
    if isinstance(stride, bool) or not isinstance(stride, int) or not 1 <= stride <= 100_000:
        raise ValueError("记录的 RSSI 采样间隔无效。")
    rssi_rate = manifest.get("rssiSampleRate")
    rate = manifest.get("sampleRate")
    if stride > 1 or rssi_rate is not None:
        if (not isinstance(rssi_rate, (int, float)) or isinstance(rssi_rate, bool) or
                not math.isfinite(rssi_rate) or rssi_rate <= 0 or not isinstance(rate, (int, float)) or
                not math.isfinite(rate) or not math.isclose(rssi_rate * stride, rate, rel_tol=1e-9)):
            raise ValueError("记录的 RSSI 采样率与速度采样率不一致。")
    return stride


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class RecordingStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "recordings.sqlite3"
        self.index_error: str | None = None
        self._initialize_index()
        self._recover()

    def _initialize_index(self) -> None:
        try:
            # Connection.__exit__ commits/rolls back but does not close SQLite.
            # Close after the transaction, including errors, before recovery can
            # rename the file on Windows. Each operation owns its own connection.
            with closing(sqlite3.connect(self.index_path)) as database, database:
                if database.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise sqlite3.DatabaseError("SQLite index failed integrity check")
                database.execute("CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, started_at REAL, manifest TEXT NOT NULL)")
        except sqlite3.DatabaseError as exc:
            if isinstance(exc, sqlite3.OperationalError):
                raise  # A locked/unwritable disk is not evidence that the index should be renamed.
            # The index is disposable; preserve the corrupt original for diagnostics.
            if self.index_path.exists():
                self.index_path.rename(self.root / f"recordings-corrupt-{time.time_ns()}.sqlite3")
            with closing(sqlite3.connect(self.index_path)) as database, database:
                database.execute("CREATE TABLE recordings (id TEXT PRIMARY KEY, started_at REAL, manifest TEXT NOT NULL)")

    def update_index(self, manifest: dict) -> None:
        try:
            with closing(sqlite3.connect(self.index_path, timeout=3)) as database, database:
                database.execute("INSERT OR REPLACE INTO recordings VALUES (?, ?, ?)",
                                 (manifest["id"], manifest["startedAt"], json.dumps(manifest, ensure_ascii=False)))
            self.index_error = None
        except sqlite3.Error as exc:
            # Raw files and manifest remain the authority; do not delete/overwrite them.
            self.index_error = str(exc)

    def directory(self, recording_id: str) -> Path:
        if not ID_PATTERN.fullmatch(recording_id):
            raise KeyError("无效采集记录 ID。")
        path = self.root / recording_id
        if path.is_symlink() or path.resolve().parent != self.root:
            raise KeyError("无效采集记录目录。")
        return path

    def _read_manifest(self, directory: Path, *, normalize_metadata: bool = True) -> dict:
        path = directory / "manifest.json"
        if path.is_symlink() or path.stat().st_size > 1024 * 1024:
            raise ValueError("无效采集元数据文件。")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("id") != directory.name:
            raise ValueError("采集元数据 ID 不一致。")
        return normalize_recording_metadata(manifest) if normalize_metadata else manifest

    def chunks(self, directory: Path) -> list[Path]:
        return sorted(path for path in directory.iterdir()
                      if CHUNK_PATTERN.fullmatch(path.name) and path.is_file() and not path.is_symlink())

    def _recover(self) -> None:
        for directory in self.root.iterdir():
            if not ID_PATTERN.fullmatch(directory.name) or not directory.is_dir() or directory.is_symlink():
                continue
            try:
                manifest = self._read_manifest(directory, normalize_metadata=False)
                if manifest.get("status") == "incomplete":
                    count, tail_bytes, valid_chunks, previous_end = 0, 0, 0, 0
                    for path in self.chunks(directory):
                        with path.open("rb") as stream:
                            magic, rate, origin, start = HEADER.unpack(stream.read(HEADER.size))
                        if magic != MAGIC or rate <= 0 or not math.isfinite(rate) or start != previous_end:
                            raise ValueError("原始分块头不连续或无效；保留原文件待人工检查。")
                        size = max(0, path.stat().st_size - HEADER.size)
                        samples, tail = divmod(size, RECORD.size)
                        count += samples
                        previous_end = start + samples
                        valid_chunks += 1
                        tail_bytes += tail
                    manifest.update(samples=count, chunks=valid_chunks, recovered=True,
                                    trailingBytes=tail_bytes, error="上次采集未正常收尾；已恢复可读取样本，完整性未经确认。")
                    atomic_json(directory / "manifest.json", manifest)
                self.update_index(manifest)
            except (OSError, ValueError, KeyError, struct.error) as exc:
                # Never hide or erase an unreadable recording by pretending it completed.
                fallback = {"id": directory.name, "name": "待检查的采集记录", "object": "", "turbine": "", "point": "",
                            "samples": 0, "sampleRate": None, "startedAt": directory.stat().st_mtime,
                            "endedAt": None, "status": "incomplete", "error": str(exc), "unit": "m/s"}
                self.update_index(fallback)

    def list(self) -> list[dict]:
        try:
            with closing(sqlite3.connect(self.index_path)) as database, database:
                rows = database.execute("SELECT manifest FROM recordings ORDER BY started_at DESC LIMIT 1000").fetchall()
            return [normalize_recording_metadata(json.loads(row[0])) for row in rows]
        except (sqlite3.Error, ValueError):
            records = []
            for path in self.root.iterdir():
                if ID_PATTERN.fullmatch(path.name) and path.is_dir() and not path.is_symlink():
                    try:
                        records.append(self._read_manifest(path))
                    except (OSError, ValueError):
                        continue
            return sorted(records, key=lambda item: item.get("startedAt", 0), reverse=True)[:1000]

    def get(self, recording_id: str) -> dict:
        directory = self.directory(recording_id)
        try:
            manifest = self._read_manifest(directory)
        except FileNotFoundError as exc:
            raise KeyError("采集记录不存在。") from exc
        wave = empty_waveform()
        chunks = self.chunks(directory)
        # Preview only the latest non-empty chunk; never load the whole raw recording.
        for path in reversed(chunks):
            with path.open("rb") as stream:
                magic, rate, origin, start = HEADER.unpack(stream.read(HEADER.size))
                if magic != MAGIC:
                    raise ValueError("无效原始数据分块。")
                count = (path.stat().st_size - HEADER.size) // RECORD.size
                if not count:
                    continue
                start_offset = max(0, count - DISPLAY_LIMIT)
                stream.seek(HEADER.size + start_offset * RECORD.size)
                rows = list(RECORD.iter_unpack(stream.read(min(count, DISPLAY_LIMIT) * RECORD.size)))
                wave.update(sampleRate=rate, sampleStart=rows[0][0],
                            values=[row[2] for row in rows],
                            rssi=[row[4] if row[5] & 2 else None for row in rows],
                            overrange=[bool(row[5] & 1) for row in rows])
                break
        wave.update(source=manifest.get("source", "polytec_ivs500"), simulation=manifest.get("simulation"))
        stride = recording_rssi_stride(manifest)
        if stride > 1:
            wave.update(rssiSampleStride=stride, rssiSampleRate=manifest["rssiSampleRate"])
        return {"recording": manifest, "waveform": wave}

    def create(self, metadata: dict) -> "RecordingWriter":
        return RecordingWriter(self, metadata)


def recording_manifest(metadata: dict, *, recording_id=None, started_at=None) -> dict:
    """Initialize record identity/accounting without filesystem I/O."""
    return {
        **metadata, "id": recording_id or uuid.uuid4().hex, "samples": 0, "sampleRate": None, "startedAt": time.time() if started_at is None else started_at,
        "sampleOrigin": None, "endedAt": None, "status": "incomplete", "error": None,
        "unit": "m/s", "rssiUnit": "%", "channels": ["CH1", "RSSI1"], "chunks": 0,
        "format": "BLADEV01/<QidifB", "overrangeSamples": 0, "missingRssiSamples": 0, "unpairedRssiSamples": 0,
        "dataLossAssessment": "not_applicable_simulation" if metadata.get("source") == "simulation" else "unverified",
        "timestampBasis": ("host epoch at simulation start + continuous sample index / source workbook sample rate"
                           if metadata.get("source") == "simulation" else "host epoch at DAQ start + velocity sample index / SDK velocity sample rate"),
    }


class RecordingWriter:
    CHUNK_SAMPLES = 262_144

    def __init__(self, store: RecordingStore, metadata: dict, *, recording_id=None, started_at=None):
        self.store = store
        manifest = recording_manifest(metadata, recording_id=recording_id, started_at=started_at)
        self.id = manifest["id"]
        self.directory = store.directory(self.id)
        self.directory.mkdir()
        self.manifest = manifest
        self.stream = None
        self.chunk_samples = 0
        self.last_commit = 0.0
        self._storage_diagnostics = {}
        self.persist()

    def _timing(self, key: str, started: float) -> None:
        diagnostics = self._storage_diagnostics
        diagnostics[key] = max(diagnostics.get(key, 0.0), (time.monotonic() - started) * 1000)

    def persist(self) -> None:
        started = time.monotonic()
        if self.stream:
            self.stream.flush()
            os.fsync(self.stream.fileno())
        self._timing("maxFlushMs", started)
        started = time.monotonic()
        # Snapshot timings once for both the authoritative manifest and index.
        # This commit's own JSON/index timings are included in the next commit;
        # never mutate a published manifest after saving it.
        self.manifest["storageDiagnostics"] = dict(self._storage_diagnostics)
        atomic_json(self.directory / "manifest.json", self.manifest)
        self._timing("maxManifestMs", started)
        started = time.monotonic()
        self.store.update_index(self.manifest)
        self._timing("maxIndexMs", started)
        self.last_commit = time.monotonic()

    def ready(self, sample_rate: float, origin: float) -> None:
        self.manifest.update(sampleRate=sample_rate, sampleOrigin=origin)
        self.persist()

    def _close_chunk(self) -> None:
        if self.stream:
            current = Path(self.stream.name)
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()
            self.stream = None
            os.replace(current, current.with_suffix(""))

    def write(self, batch: Batch) -> None:
        count = len(batch.values)
        stride = batch.rssi_sample_stride
        if isinstance(stride, bool) or not isinstance(stride, int) or not 1 <= stride <= 100_000:
            raise ValueError("RSSI 采样间隔无效。")
        if batch.sample_start % stride or self.manifest.get("rssiSampleStride", stride) != stride:
            raise ValueError("RSSI 采样间隔或起点在采集中发生变化。")
        if len(batch.rssi) != len(batch.rssi_raw):
            raise ValueError("RSSI 原始值与换算值数量不一致。")
        if count != len(batch.velocity_raw) or count != len(batch.overrange) or batch.sample_start != self.manifest["samples"]:
            raise ValueError("SDK 批次样本结构或序号不连续。")
        if batch.sample_rate != self.manifest["sampleRate"] or batch.started_at != self.manifest["sampleOrigin"]:
            raise ValueError("采集过程中采样率或时间起点发生变化。")
        if not count:
            return
        self.manifest.update(rssiSampleStride=stride, rssiSampleRate=batch.sample_rate / stride)
        if self.stream is None or self.chunk_samples >= self.CHUNK_SAMPLES:
            self._close_chunk()
            chunk_number = self.manifest["chunks"]
            path = self.directory / f"chunk-{chunk_number:08d}.bin.part"
            self.stream = path.open("xb", buffering=0)
            self.stream.write(HEADER.pack(MAGIC, batch.sample_rate, batch.started_at, batch.sample_start))
            self.manifest["chunks"] += 1
            self.chunk_samples = 0
        packing_started = time.monotonic()
        data, missing, not_sampled = pack_records(batch)
        self._timing("maxPackingMs", packing_started)
        # The raw batch reaches the file before any display buffer is updated.
        write_started = time.monotonic()
        written = self.stream.write(memoryview(data).cast("B"))
        self._timing("maxFileWriteMs", write_started)
        if written != data.nbytes:
            raise OSError("原始数据写入不完整；采集已停止。")
        paired_rssi = (count + stride - 1) // stride
        if len(batch.rssi_raw) > paired_rssi:
            # Retain unexpected surplus RSSI without claiming that it is a second channel
            # or inventing correspondence to velocity samples that weren't received.
            extra_count = len(batch.rssi_raw) - paired_rssi
            with (self.directory / "unpaired-rssi.bin").open("ab", buffering=0) as extra:
                payload = struct.pack("<QQ", batch.sample_start, extra_count)
                payload += b"".join(struct.pack("<if", batch.rssi_raw[index], batch.rssi[index])
                                    for index in range(paired_rssi, len(batch.rssi_raw)))
                if extra.write(payload) != len(payload):
                    raise OSError("未配对 RSSI 原始数据写入不完整。")
                os.fsync(extra.fileno())
            self.manifest["unpairedRssiSamples"] += extra_count
        self.chunk_samples += count
        self.manifest["samples"] += count
        self.manifest["overrangeSamples"] += sum(batch.overrange)
        self.manifest["missingRssiSamples"] += missing
        # Preserve BLADEV01's existing absent-flag count for old readers while
        # distinguishing unsampled velocity positions from an actual RSSI loss.
        self.manifest["rssiNotSampledVelocitySamples"] = self.manifest.get("rssiNotSampledVelocitySamples", 0) + not_sampled
        self.manifest["rssiMissingExpectedSamples"] = self.manifest.get("rssiMissingExpectedSamples", 0) + missing - not_sampled
        if time.monotonic() - self.last_commit >= 1.0:
            self.persist()

    def finish(self, error: str | None) -> None:
        try:
            self._close_chunk()
            self.manifest.update(status="error" if error else "complete", error=error, endedAt=time.time())
            self.persist()
        except OSError:
            # Existing on-disk manifest stays incomplete if the disk cannot commit.
            self.manifest.update(status="incomplete", error=error or "数据落盘失败，采集记录未完成。")
            if self.stream:
                self.stream.close()
                self.stream = None
            raise
