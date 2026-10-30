"""Read-only adapters for the existing BladeVMS export; no server credentials or uploads."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path
import zipfile
from typing import Iterator

import numpy as np

from .geometry import SignalError
from .models import RawRecording, digest


def read_csv_recording(blob: bytes, manifest: dict, *, source_name: str = "") -> RawRecording:
    text = blob.decode("utf-8-sig")
    first, separator, rest = text.partition("\n")
    if not separator or not first.startswith("# BladeVMS "):
        raise SignalError("CSV_HEADER_INVALID", "expected complete # BladeVMS JSON header")
    header = json.loads(first[len("# BladeVMS "):])
    required = ("time_s", "velocity_m_s", "RSSI_percent", "overrange")
    reader = csv.reader(io.StringIO(rest))
    names = next(reader, None)
    if names is None or any(name not in names for name in required):
        raise SignalError("CSV_COLUMNS_INVALID", str(names))
    positions = [names.index(name) for name in required]
    values = []
    blank_row = None
    for row_no, row in enumerate(reader, start=3):
        if not row or all(not s.strip() for s in row):
            blank_row = blank_row or row_no
            continue
        if blank_row is not None:
            raise SignalError("CSV_ROW_GAP", f"interior blank row {blank_row}; source indices cannot be compressed")
        try:
            values.append([float(row[i]) if row[i].strip() else np.nan for i in positions])
        except (ValueError, IndexError) as exc:
            # Preserve raw bytes; refuse ambiguous text tokens rather than silently normalizing them.
            raise SignalError("CSV_NUMERIC_INVALID", f"row {row_no}") from exc
    if not values:
        raise SignalError("EMPTY_RECORDING", source_name)
    data = np.asarray(values, dtype=float)
    issues: list[str] = []
    for key in ("sampleRate", "samples", "unit"):
        if key in manifest and key in header and manifest[key] != header[key]:
            issues.append(f"SOURCE_METADATA_CONFLICT:{key}")
    fs = manifest.get("sampleRate", header.get("sampleRate"))
    if fs is None:
        raise SignalError("SAMPLE_RATE_MISSING", source_name)
    if manifest.get("samples") is not None and int(manifest["samples"]) != len(data):
        issues.append("SOURCE_METADATA_CONFLICT:actualRowCount")
    if manifest.get("unit") not in (None, "m/s"):
        raise SignalError("UNIT_CONFLICT", "velocity_m_s column conflicts with manifest unit")
    for key in ("radialPointName", "radiusM", "azimuthDeg", "bladeId"):
        a = (manifest.get("pointCycle") or {}).get(key)
        b = (header.get("pointCycle") or {}).get(key)
        if a is not None and b is not None and a != b:
            issues.append(f"SOURCE_METADATA_CONFLICT:pointCycle.{key}")
    rid = manifest.get("id") or manifest.get("recordingId") or digest(blob)
    return RawRecording(str(rid), float(fs), data[:,0], data[:,1], data[:,2], data[:,3],
        manifest, digest(blob), source_name, tuple(issues))


def iter_zip_recordings(path: str | Path) -> Iterator[RawRecording]:
    """Existing manifest paths define records; filenames do not define blade identity."""
    with zipfile.ZipFile(path) as archive:
        names = sorted(n for n in archive.namelist() if n.endswith("/manifest.json") or n == "manifest.json")
        if not names:
            raise SignalError("MANIFEST_MISSING", str(path))
        for name in names:
            manifest = json.loads(archive.read(name))
            waveform = name[:-len("manifest.json")] + "waveform.csv"
            if waveform not in archive.namelist():
                raise SignalError("WAVEFORM_MISSING", waveform)
            yield read_csv_recording(archive.read(waveform), manifest, source_name=f"{Path(path).name}:{name}")
