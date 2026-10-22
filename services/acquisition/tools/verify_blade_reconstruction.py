"""Verify every exported sample against its immutable source CSV and mapping."""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blade_acquisition.blade_passes import _preprocess


def verify(output):
    result = json.loads((output / "result.json").read_text(encoding="utf-8"))
    validation = result["offlineValidation"]
    root = Path(validation["inputDirectory"])
    task = json.loads((root / "task.json").read_text(encoding="utf-8"))
    records = {record["recordingId"]: record for record in task["records"]}
    raw_values = {}
    for source in validation["sourceFiles"]:
        path = (root / source["path"]).resolve()
        assert path.is_relative_to(root.resolve()), "Source outside task directory"
        with path.open("rb") as stream:
            assert hashlib.file_digest(stream, "sha256").hexdigest() == source["sha256"], "Source SHA256 changed"
        with path.open(encoding="utf-8-sig") as stream:
            metadata = json.loads(stream.readline()[len("# BladeVMS "):])
        raw_values[metadata["recordingId"]] = np.loadtxt(path, delimiter=",", skiprows=2, usecols=(1,))
    total, summaries = 0, []
    for point in result["synthesis"]["mergedPoints"]:
        segments = point["segments"]
        processed = {segment["segmentId"]: _preprocess(raw_values[segment["sourceRecordingId"]][segment["originalStart"]:segment["originalEnd"]], result["parameters"]["detrend"]) for segment in segments}
        path = (output / point["mergedFile"]).resolve()
        assert path.is_relative_to(output.resolve()), "Export outside result directory"
        count, part = 0, 0
        with gzip.open(path, "rt", encoding="utf-8", newline="") as stream:
            for row in csv.DictReader(stream):
                while count >= segments[part]["mergedEnd"]:
                    part += 1
                segment = segments[part]
                local = count - segment["mergedStart"]
                original = segment["originalStart"] + local
                assert int(row["merged_index"]) == count
                assert row["segment_id"] == segment["segmentId"]
                assert row["source_recording_id"] == segment["sourceRecordingId"]
                assert int(row["original_sample_index"]) == original
                assert float(row["azimuth_deg"]) == segment["azimuthDeg"]
                assert records[row["source_recording_id"]]["radialPointId"] == point["radialPointId"]
                assert float(row["raw_velocity_m_s"]) == raw_values[row["source_recording_id"]][original]
                assert math.isclose(float(row["processed_velocity_m_s"]), processed[row["segment_id"]][local], rel_tol=1e-11, abs_tol=1e-14)
                assert abs(float(row["compressed_time_s"]) - segment["compressedStartSeconds"] - local / segment["sampleRate"]) <= 5.1e-10
                assert abs(float(row["original_time_s"]) - original / segment["sampleRate"]) <= 5.1e-10
                count += 1
        assert count == point["samples"], "Export row count differs from extraction"
        total += count
        summaries.append({"point": point["radialPointName"], "rows": count, "segments": len(segments), "allSamplesMatchSource": True})
    assert total == result["coverage"]["validSamples"]
    assert validation["allBoundariesReproduced"]
    for response in result["synthesis"]["candidates"] + result["synthesis"]["bandResponses"]:
        assert response["points"]
        assert math.isclose(max(point["normalizedAmplitude"] for point in response["points"]), 1)
        for point in response["points"]:
            assert point["spatialPhaseDeg"] is None
            assert all(math.isfinite(point[key]) for key in ("normalizedAmplitude", "velocityRmsMps", "displacementRmsM"))
    evidence = {"passed": True, "samplesVerified": total, "sourceCsvHashesUnchanged": len(raw_values),
                "boundaryReplaysMatched": len(validation["boundaryAudits"]), "points": summaries,
                "scope": "all CSV rows, raw and detrended values, time coordinates, indices, source SHA256; no physical modal validation"}
    (output / "verification.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    return evidence


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    print(json.dumps(verify(parser.parse_args().output.resolve()), ensure_ascii=False, indent=2))
