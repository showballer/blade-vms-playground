"""Independent readback of the actual Word download and live browser DOM evidence."""
import json
from pathlib import Path
from zipfile import ZipFile
from lxml import etree

root = Path("artifacts/report-wide")
browser = json.loads((root / "browser-evidence.json").read_text())
with ZipFile(root / "after.docx") as archive:
    doc = etree.fromstring(archive.read("word/document.xml"))
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
tables = []
for table in doc.findall(".//w:tbl", ns):
    rows = [["".join(c.itertext()) for c in row.findall("w:tc", ns)] for row in table.findall("w:tr", ns)]
    tables.append({"headers": rows[0], "rows": rows[1:]})
assert len(tables) == len(browser["tables"]) == 18
for word, html in zip(tables, browser["tables"]):
    assert word == {k: html[k] for k in ("headers", "rows")}
    assert len(word["headers"]) <= 5
    assert html["width"] <= html["parentWidth"] + 1
assert browser["sections"] == 10
wide = tables[3:11]
headers = wide[0]["headers"][:1] + [h for t in wide for h in t["headers"][1:]]
assert len(headers) == 32 and len(set(headers)) == 32
saved = json.loads((root / "expected.json").read_text())["report"]["analysisSnapshots"]
expected = next(a["result"]["dataset"] for a in saved if a["type"] == "fft")
for r, row in enumerate(expected["rows"][:8]):
    rebuilt = wide[0]["rows"][r][:1] + [v for t in wide for v in t["rows"][r][1:]]
    assert len(rebuilt) == 32
    for value, actual in zip(row, rebuilt):
        assert abs(float(actual) - value) <= max(1e-12, abs(value) * 5e-8)
for start, trend in zip([12, 15], [a for a in saved if a["type"] == "health-trend"]):
    groups = tables[start:start + 3]
    assert len(groups[0]["headers"][:2] + [h for t in groups for h in t["headers"][2:]]) == 10
    for r, row in enumerate(trend["result"]["dataset"]["rows"][:8]):
        rebuilt = groups[0]["rows"][r][:2] + [v for t in groups for v in t["rows"][r][2:]]
        assert rebuilt[1] == row[1]
        for i in [0, *range(2, 10)]:
            assert abs(float(rebuilt[i]) - row[i]) <= max(1e-12, abs(row[i]) * 5e-8)
print("PASS actual Word / live browser: 18 identical tables, 10 sections, all 32 columns and both eight-indicator trend previews retained")
