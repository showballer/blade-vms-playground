"""Independent export readers for coding QA, not a Python algorithm integration."""
import csv
import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import numpy as np
from scipy.io import loadmat
from openpyxl import load_workbook

root = Path(__file__).resolve().parent.parent / "artifacts"
checks = []


def read_export(filename):
    path = root / filename
    if path.suffix == ".json":
        document = json.loads(path.read_text(encoding="utf-8"))
        rows, reader = document["rows"], "json"
    elif path.suffix in (".csv", ".txt"):
        with path.open(encoding="utf-8-sig", newline="") as stream:
            table = list(csv.reader(stream, delimiter="," if path.suffix == ".csv" else "\t"))
        document = json.loads(table[1][1])
        rows = [[float(cell) if document["columns"][i]["type"] == "number" else cell for i, cell in enumerate(row)] for row in table[3:]]
        reader = "csv.reader"
    elif path.suffix == ".xlsx":
        book = load_workbook(path, read_only=True, data_only=False)
        rows = [list(row) for row in book["结果数据"].iter_rows(min_row=2, values_only=True)]
        assert all(cell.data_type != "f" for row in book["结果数据"] for cell in row)
        chunks = [row for row in book["元信息"].iter_rows(values_only=True) if row[0] == "metadata_json"]
        assert [row[1] for row in chunks] == list(range(1, len(chunks) + 1))
        document = json.loads("".join(row[2] for row in chunks))
        reader = "openpyxl"
        book.close()
    else:
        assert path.suffix == ".mat"
        result = loadmat(path)
        document = json.loads(bytes(result["metadata_json_utf8"].flatten().astype(np.uint8)).decode("utf-8"))
        indices = result["numeric_column_indices"].flatten().astype(int).tolist()
        assert indices == document["numericColumnIndices"] and document["indexBase"] == 0
        rows = [[None] * len(document["columns"]) for _ in range(document["rowCount"])]
        for row_index, numeric_row in enumerate(result["values"].tolist()):
            for i, value in zip(indices, numeric_row):
                rows[row_index][i] = value
        for column in document["textColumns"]:
            for row_index, value in enumerate(column["values"]):
                rows[row_index][column["columnIndex"]] = value
        reader = "scipy.io.loadmat"
    assert document["schema"] == "blade-vms/dataset-v1"
    assert document.get("rowCount", len(rows)) == len(rows)
    return rows, document, reader


expected_trend = [[i, (date(2024, 2, 1) + timedelta(days=i)).isoformat(), *[round(v, 8) for v in [i*.85 + math.sin(i*.7)*2, -i*.14 + math.sin(i*.65), -i*.11 + math.cos(i*.8), i*.45 + math.sin(i*.55)*1.5, i*.65 + math.sin(i*.6)*2.5, i*.7 + math.sin(i*.5)*2, i*.55 + math.sin(i*.75)*1.8, i*.9 + math.sin(i*.4)]]] for i in range(30)]
expected_wave = [[0, 1], [.25, -2], [.5, 3], [.75, -4]]
files = [(f"health-trend-data/{prefix}{key}.{ext}", key, False) for prefix in ("", "api-") for key in ("trend", "waveform") for ext in ("json", "csv", "txt", "xlsx", "mat")]
files += [(f"health-trend-ui/ui-{key}.{ext}", key, False) for key in ("trend", "waveform") for ext in ("json", "csv", "txt", "xlsx", "mat")]
files += [("health-trend-ui/preview.json", "trend", True), ("health-trend-ui/frozen-waveform.json", "waveform", False)]
for filename, key, preview in files:
    rows, document, reader = read_export(filename)
    assert rows == (expected_trend if key == "trend" else expected_wave), filename
    metadata = document["metadata"]
    if key == "trend":
        assert metadata["workflow"] == "health-trend-v1" and metadata["demo"] is True
        assert metadata["source"] == "demo" and metadata["thresholds"]["status"] == "missing"
        assert metadata["sampleVersion"] == "multi-indicator-demo-v2"
        assert [c["key"] for c in document["columns"]] == ["index", "date", "amplitude", "frequency", "modal", "band", "peak", "peakToPeak", "mainAmplitude", "damping"]
        assert [c["unit"] for c in document["columns"]] == ["0-based", "YYYY-MM-DD"] + ["%"] * 8
    else:
        assert metadata["source"] == "import" and metadata["task"]["sampleRate"] == 4
        assert document["columns"][0]["unit"] == "s"
    if not preview:
        assert metadata["datasetKey"] == key
        analysis = metadata["analysis"]
        assert analysis["parameters"]["workflow"] == "health-trend-v1"
        assert analysis["result"].get("datasets") is None
        assert len(analysis["result"]["annotations"]) == 2
        assert all(a["actor"] != "伪造" for a in analysis["result"]["annotations"])
        if filename.startswith("health-trend-data/"):
            assert sum(a["status"] == "withdrawn" for a in analysis["result"]["annotations"]) == 1
        else:
            assert all(a["status"] == "active" for a in analysis["result"]["annotations"])
    checks.append({"file": filename, "reader": reader, "status": "pass"})

(root / "health-trend-data/independent-readers.json").write_text(json.dumps({"time": datetime.now(timezone.utc).isoformat(), "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"PASS {len(checks)} actual trend exports: dates, units, matrices, provenance and annotation history")
