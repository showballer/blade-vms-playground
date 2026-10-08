"""Extract velocity/RSSI columns from a supplied XLSX; never executes source code.

Standard-library-only conversion. The workbook and generator are read only;
source SHA-256 values make the shipped playback fixture auditable.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import xml.etree.ElementTree as ET
from zipfile import ZipFile

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def read_sheets(path):
    with ZipFile(path) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            strings = ["".join(node.itertext()) for node in root]
        links = {node.attrib["Id"]: node.attrib["Target"] for node in
                 ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        result = {}
        for sheet in ET.fromstring(archive.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS):
            target = links[sheet.attrib[RID]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            rows = []
            for row in ET.fromstring(archive.read(target)).findall("s:sheetData/s:row", NS):
                values = {}
                for cell in row:
                    reference = cell.attrib["r"]
                    column = "".join(c for c in reference if c.isalpha())
                    value = cell.find("s:v", NS)
                    text = value.text if value is not None else None
                    kind = cell.attrib.get("t")
                    if kind == "s":
                        value = strings[int(text)]
                    elif kind == "inlineStr":
                        value = "".join(cell.find("s:is", NS).itertext())
                    elif kind == "str":
                        value = text
                    else:
                        value = float(text) if text is not None else None
                    values[column] = value
                rows.append((int(row.attrib["r"]), values))
            result[sheet.attrib["name"]] = rows
        return result


def convert(workbook_path, script_path):
    sheets = read_sheets(workbook_path)
    parameters = {row["A"]: row.get("B") for number, row in sheets["Parameters"] if 5 <= number <= 13}
    source_rows = [row for number, row in sheets["Parameters"] if 16 <= number <= 18]
    points = []
    for index, source in enumerate(source_rows, 1):
        sheet_name = f"P{index}_xL{source['C']:.2f}"
        rows = {number: row for number, row in sheets[sheet_name]}
        if [rows[4].get(c) for c in ["B", "J", "K", "L"]] != ["time_s", "velocity_m_s", "RSSI_percent", "quality"]:
            raise ValueError(f"Unexpected column schema in {sheet_name}")
        data = [row for number, row in sheets[sheet_name] if number >= 5]
        rate = source["E"]
        times = [row["B"] for row in data]
        velocity = [row["J"] for row in data]
        rssi = [row["K"] for row in data]
        if len(data) != int(source["H"]) or len(data) < 64 or not math.isfinite(rate) or rate <= 0:
            raise ValueError("Invalid sample count/rate")
        if any(not math.isfinite(value) for value in times + velocity + rssi):
            raise ValueError("Non-finite sample")
        if any(not 0 <= value <= 100 for value in rssi):
            raise ValueError("RSSI must be a percentage")
        dt = statistics.median(b - a for a, b in zip(times, times[1:]))
        if abs(dt * rate - 1) > 1e-6 or any(abs(b - a - dt) > dt * 1e-6 for a, b in zip(times, times[1:])):
            raise ValueError("Non-uniform time axis")
        points.append({"id": f"P{index}", "label": f"测点 {index} · x/L {source['C']:.2f}",
                       "sheet": sheet_name, "sourceStaticFile": source["A"], "position": source["C"],
                       "sampleRate": rate, "samples": len(data), "durationSeconds": len(data) / rate,
                       "velocity": velocity, "rssi": rssi,
                       "lowReturn": [row["L"] == "LOW_RETURN" for row in data]})
    return {"schemaVersion": 1, "unit": "m/s", "rssiUnit": "%",
            "sourceFile": workbook_path.name, "sourceSha256": hashlib.sha256(workbook_path.read_bytes()).hexdigest(),
            "sourceScript": script_path.name, "sourceScriptSha256": hashlib.sha256(script_path.read_bytes()).hexdigest(),
            "rpm": parameters["Rotor speed"], "bladeCount": int(parameters["Blade count"]),
            "baseFrequencyHz": parameters["Static base frequency"], "seed": int(parameters["Seed"]),
            "notice": "源工作簿由静态测量合成旋转信号，仅供软件调试；LOW_RETURN 为低回波，不代表结构损伤。",
            "points": points}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("generator", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    value = convert(arguments.workbook, arguments.generator)
    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with arguments.output.open("xb") as output:
        output.write(gzip.compress(payload, compresslevel=9, mtime=0))
    print(json.dumps({"output": str(arguments.output), "sha256": value["sourceSha256"],
                      "points": [{key: p[key] for key in ("id", "sampleRate", "samples")} for p in value["points"]]}))
