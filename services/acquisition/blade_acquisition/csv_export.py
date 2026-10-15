"""Bounded-memory export of complete raw recordings with explicit provenance."""
from __future__ import annotations

import csv
import io
import json
import math

from .storage import HEADER, MAGIC, RECORD


def prepare_export(store, recording_id):
    directory = store.directory(recording_id)
    manifest = store._read_manifest(directory)
    if manifest.get("status") != "complete":
        raise BlockingIOError("请先停止并完整保存记录，再导出原始数据。")
    rate = manifest.get("sampleRate")
    if not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
        raise ValueError("记录采样率无效。")
    chunks, expected = [], 0
    for path in store.chunks(directory):
        if path.name.endswith(".part"):
            raise ValueError("已完成记录仍含未关闭分块。")
        with path.open("rb") as source:
            header = source.read(HEADER.size)
        if len(header) != HEADER.size:
            raise ValueError("原始分块头不完整。")
        magic, chunk_rate, origin, start = HEADER.unpack(header)
        samples, trailing = divmod(path.stat().st_size - HEADER.size, RECORD.size)
        if (magic != MAGIC or chunk_rate != rate or start != expected or trailing or
                not math.isfinite(origin) or origin != manifest.get("sampleOrigin")):
            raise ValueError("原始分块不完整或与记录信息不一致。")
        chunks.append((path, samples))
        expected += samples
    if expected != manifest["samples"]:
        raise ValueError("原始记录样本数与元数据不一致。")
    return manifest, chunks


def stream_csv(manifest, chunks):
    simulation = manifest.get("simulation") or {}
    metadata = {"format": "blade-vms-csv-1", "recordingId": manifest["id"], "name": manifest.get("name", ""),
                "source": manifest.get("source", "polytec_ivs500"), "simulation": manifest.get("simulation"),
                "sampleRate": manifest["sampleRate"], "samples": manifest["samples"], "unit": "m/s",
                "point": manifest.get("point", ""), "position": simulation.get("position"),
                "rpm": simulation.get("rpm"), "dataLossAssessment": manifest.get("dataLossAssessment", "unverified")}
    if manifest.get("turntable"):
        metadata["turntable"] = manifest["turntable"]
    yield "# BladeVMS " + json.dumps(metadata, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
    yield "time_s,velocity_m_s,RSSI_percent,overrange\n"
    expected = 0
    for path, count in chunks:
        with path.open("rb") as source:
            source.seek(HEADER.size)
            remaining = count
            while remaining:
                amount = min(4096, remaining)
                payload = source.read(amount * RECORD.size)
                if len(payload) != amount * RECORD.size:
                    raise ValueError("导出期间原始分块被截断。")
                output = io.StringIO(newline="")
                writer = csv.writer(output, lineterminator="\n")
                for index, _raw, velocity, _rssi_raw, rssi, flags in RECORD.iter_unpack(payload):
                    if index != expected or not math.isfinite(velocity) or (flags & 2 and not math.isfinite(rssi)):
                        raise ValueError("原始样本序号或数值无效。")
                    writer.writerow([format(index / manifest["sampleRate"], ".17g"), format(velocity, ".17g"),
                                     format(rssi, ".9g") if flags & 2 else "", int(bool(flags & 1))])
                    expected += 1
                remaining -= amount
                yield output.getvalue()
            if source.read(1):
                raise ValueError("导出期间原始分块发生变化。")
    if expected != manifest["samples"]:
        raise ValueError("原始记录导出样本数不一致。")
