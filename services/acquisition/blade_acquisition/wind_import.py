"""Bounded table preview. Column selection and unit confirmation precede persistence."""
import base64
import csv
import io
import hashlib
import json
import math
import re
import shutil
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .web_rotation import workbook_tables

MAX_BYTES = 16 * 1024 * 1024
MAX_ROWS = 250_000
FIELDS = ("windSpeed", "rpm", "windDirection", "powerKw", "temperatureC")
ALIASES = {
    "time": ("time", "时间", "日期时间", "timestamp"),
    "turbineCode": ("turbinecode", "风机", "风机编号", "机组", "名称"),
    "windSpeed": ("windspeed", "风速", "当前风速"),
    "rpm": ("rpm", "轮毂转速", "转速", "主轴转速"),
    "windDirection": ("winddirection", "风向"),
    "powerKw": ("powerkw", "有功功率", "发电机侧有功功率", "功率", "发电机有功功率"),
    "temperatureC": ("temperaturec", "外界温度", "环境温度", "舱外温度"),
}
UNITS = {
    "windSpeed": {"m/s": (1, 0), "km/h": (1 / 3.6, 0)},
    "rpm": {"rpm": (1, 0), "rps": (60, 0)},
    "windDirection": {"deg": (1, 0)},
    "powerKw": {"kW": (1, 0), "W": (.001, 0), "MW": (1000, 0)},
    "temperatureC": {"C": (1, 0), "F": (5 / 9, -32 * 5 / 9)},
}
RANGES = {"windSpeed": (0, 150), "rpm": (0, 10000), "windDirection": (-360, 360), "powerKw": (-100000, 100000), "temperatureC": (-100, 100)}

# This agreed export template contains all five metrics in one minute table.
# Units are suggestions for explicit confirmation, not an implicit conversion.
MINUTE_HEADERS = {"名称", "时间", "风速", "发电机有功功率", "主轴转速", "舱外温度", "风向"}
MINUTE_UNITS = {"windSpeed": "m/s", "rpm": "rpm", "powerKw": "kW", "temperatureC": "C", "windDirection": "deg"}


def _suggestions(headers):
    mapping = {key: next((header for header in headers if header.lower() in aliases), "") for key, aliases in ALIASES.items()}
    result = {"suggestedMapping": mapping, "suggestedUnits": {}}
    if len(headers) == len(MINUTE_HEADERS) and set(headers) == MINUTE_HEADERS:
        result.update(sourceFormat="turbine-minute-v1", suggestedUnits=dict(MINUTE_UNITS))
    if mapping["windDirection"]:
        # A signed source angle is not necessarily a north-referenced bearing.
        # Preserve it exactly; no modulo, heading conversion or directional claim.
        result["windDirectionReference"] = "unspecified"
    return result


def _table(raw, filename):
    if filename.lower().endswith(".xlsx"):
        tables = [(name, rows) for name, rows in workbook_tables(raw) if rows]
        if len(tables) != 1:
            raise ValueError("请仅保留一个数据工作表，首行为列名；Excel 时间请保存为文本")
        rows, encoding = tables[0][1], "xlsx"
    else:
        try:
            text, encoding = raw.decode("utf-8-sig"), "UTF-8"
        except UnicodeDecodeError:
            text, encoding = raw.decode("gb18030"), "GB18030"
        rows = list(csv.reader(io.StringIO(text)))
    if not 2 <= len(rows) <= MAX_ROWS + 1:
        raise ValueError("每份文件需要表头和 1～250000 行数据")
    headers = [str(v or "").strip() for v in rows[0]]
    if not 1 <= len(headers) <= 16 or any(not h or len(h) > 100 for h in headers) or len(set(headers)) != len(headers):
        raise ValueError("表头必须包含 1～16 个非空且不重复的列名")
    data = []
    for i, row in enumerate(rows[1:], 2):
        if len(row) != len(headers):
            raise ValueError(f"第 {i} 行列数与表头不一致")
        if any(v == "FORMULA_NOT_SUPPORTED" or len(str(v or "")) > 500 for v in row):
            raise ValueError(f"第 {i} 行含公式或过长内容，请粘贴为数值")
        data.append(["" if v is None else str(v).strip() for v in row])
    return headers, data, encoding


def _folder(root):
    directory = root / "wind-imports"
    directory.mkdir(exist_ok=True, mode=0o700)
    return directory


def _token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("工况预览标识无效，请重新上传")
    return value


def stage_preview(root: Path, payload):
    """Persist one upload inside the account; return five rows, never the full file."""
    filename = payload.get("filename")
    if not isinstance(filename, str) or not filename.lower().endswith((".csv", ".xlsx")) or len(filename) > 200:
        raise ValueError("请选择 CSV 或 XLSX")
    source = Path(payload.get("inputFile", "")).resolve()
    if source.parent != root.resolve() or not source.name.startswith(".wind-upload-"):
        raise ValueError("工况上传文件无效")
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError("每份工况文件需要小于 16 MB")
    directory = _folder(root)
    for item in directory.iterdir():
        if item.is_file() and item.stat().st_mtime < time.time() - 86400:
            item.unlink()
    if sum(p.stat().st_size for p in directory.iterdir() if p.is_file()) + source.stat().st_size > 256 * 1024 * 1024:
        raise ValueError("临时工况文件过多，请完成已上传文件的导入后重试")
    raw = source.read_bytes()
    headers, rows, encoding = _table(raw, filename)
    token = uuid.uuid4().hex
    summary = {"token": token, "filename": filename, "headers": headers, "rows": rows[:5], "rowCount": len(rows),
               "encoding": encoding, "sha256": hashlib.sha256(raw).hexdigest(), **_suggestions(headers)}
    shutil.copyfile(source, directory / f"{token}.source")
    (directory / f"{token}.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    return summary


def _timestamp(value, offset):
    try:
        # Only an explicit ISO date/date-time, never an Excel serial or locale-dependent parse.
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?", value):
            raise ValueError()
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            date = date.replace(tzinfo=offset)
        return date.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        raise ValueError("时间格式无效，应为 YYYY-MM-DD HH:mm:ss 或带时区的 ISO 时间") from None


def merge_staged(root: Path, payload):
    files = payload.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 8:
        raise ValueError("一次请选择 1～8 份工况文件")
    offset = payload.get("timezoneOffset")
    if not isinstance(offset, str) or not re.fullmatch(r"[+-](?:0\d|1[0-4]):[0-5]\d", offset) or (offset[1:3] == "14" and offset[-2:] != "00"):
        raise ValueError("请确认原始文件的时区，例如 +08:00")
    tz = timezone(timedelta(minutes=(1 if offset[0] == "+" else -1) * (int(offset[1:3]) * 60 + int(offset[-2:]))))
    units = payload.get("units")
    if not isinstance(units, dict):
        raise ValueError("请确认原始文件各指标的单位")
    directory = _folder(root)
    merged, sources, tokens, seen_cells = {}, [], set(), set()
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("工况文件参数无效")
        token = _token(item.get("token"))
        if token in tokens:
            raise ValueError("同一文件不能重复导入")
        tokens.add(token)
        meta_path = directory / f"{token}.json"
        if not meta_path.is_file() or meta_path.stat().st_mtime < time.time() - 86400:
            raise ValueError("工况预览已过期，请重新上传")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        headers, rows, _ = _table((directory / f"{token}.source").read_bytes(), meta["filename"])
        mapping = item.get("mapping")
        if not isinstance(mapping, dict) or any(key not in ALIASES or not isinstance(column, str) for key, column in mapping.items()):
            raise ValueError("工况列映射无效")
        used = [column for column in mapping.values() if column]
        if len(set(used)) != len(used) or any(column not in headers for column in used):
            raise ValueError("不同字段不能映射同一列，且列名必须存在")
        if not mapping.get("time") or not mapping.get("turbineCode") or not any(mapping.get(field) for field in FIELDS):
            raise ValueError("每份文件须映射时间、风机编号及至少一个工况指标")
        selected = [field for field in FIELDS if mapping.get(field)]
        for field in selected:
            if not isinstance(units.get(field), str) or units[field] not in UNITS[field]:
                raise ValueError(f"请确认 {field} 的原始单位")
        indices = {key: headers.index(column) for key, column in mapping.items() if column}
        for number, cells in enumerate(rows, 2):
            try:
                turbine = cells[indices["turbineCode"]].strip()
                if not turbine or len(turbine) > 120:
                    raise ValueError("缺少风机编号")
                stamp = _timestamp(cells[indices["time"]], tz)
                key = (turbine, stamp)
                values = {}
                for field in selected:
                    cell_key = (*key, field)
                    if cell_key in seen_cells:
                        raise ValueError(f"同风机、同时间的 {field} 重复，不自动覆盖")
                    seen_cells.add(cell_key)
                    text = cells[indices[field]].strip()
                    if not text:
                        continue  # An absent channel is missing, never zero.
                    value = float(text)
                    factor, shift = UNITS[field][units[field]]
                    value = value * factor + shift
                    lower, upper = RANGES[field]
                    if not math.isfinite(value) or not lower <= value <= upper:
                        raise ValueError(f"{field} 超出范围")
                    values[field] = value
                if not values:
                    continue
                merged.setdefault(key, {"time": stamp, "turbineCode": turbine}).update(values)
                if len(merged) > MAX_ROWS:
                    raise ValueError("合并后超过 250000 个风机时间点，请按日期拆分")
            except (ValueError, OverflowError) as error:
                raise ValueError(f"{meta['filename']} 第 {number} 行：{error}") from None
        source = {"filename": meta["filename"], "rowCount": len(rows), "sha256": meta["sha256"], "mapping": mapping}
        if meta.get("sourceFormat") == "turbine-minute-v1":
            source["sourceFormat"] = meta["sourceFormat"]
        if mapping.get("windDirection"):
            source["windDirectionReference"] = "unspecified"
        sources.append(source)
    rows = sorted(merged.values(), key=lambda row: (row["time"], row["turbineCode"]))
    if not rows:
        raise ValueError("没有可导入的工况数值")
    complete = [row for row in rows if "windSpeed" in row and "rpm" in row]
    counts = {field: sum(field in row for row in rows) for field in FIELDS}
    result_token = uuid.uuid4().hex
    (directory / f"{result_token}.merged.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"resultToken": result_token, "rowCount": len(rows), "metricCounts": counts, "matchedRowCount": len(complete),
            "matchedStart": complete[0]["time"] if complete else None, "matchedEnd": complete[-1]["time"] if complete else None,
            "start": rows[0]["time"], "end": rows[-1]["time"], "sources": sources, "timezoneOffset": offset,
            "sourceUnits": {field: units[field] for field in FIELDS if any(source["mapping"].get(field) for source in sources)},
            **({"windDirectionReference": "unspecified"} if counts["windDirection"] else {})}


def preview(payload):
    filename=payload.get("filename")
    encoded=payload.get("base64")
    if not isinstance(filename,str) or not filename.lower().endswith((".csv",".xlsx")):
        raise ValueError("请选择 CSV 或 XLSX")
    if not isinstance(encoded,str) or len(encoded)>6*1024*1024:
        raise ValueError("工况文件不能超过 4 MB")
    raw=base64.b64decode(encoded,validate=True)
    if len(raw)>4*1024*1024: raise ValueError("工况文件不能超过 4 MB")
    if filename.lower().endswith(".xlsx"):
        tables=list(workbook_tables(raw))
        populated=[(name,rows) for name,rows in tables if rows]
        if len(populated)!=1: raise ValueError("请仅保留一个数据工作表，首行为列名；时间列请使用带时区的 ISO 文本")
        rows=populated[0][1]
    else:
        try: text=raw.decode("utf-8-sig")
        except UnicodeDecodeError: text=raw.decode("gb18030")
        rows=list(csv.reader(io.StringIO(text)))
    if not 2<=len(rows)<=50001: raise ValueError("需要表头和 1～50000 行数据")
    headers=[str(v or "").strip() for v in rows[0]]
    if not 1<=len(headers)<=16 or any(not h or len(h)>100 for h in headers) or len(set(headers))!=len(headers):
        raise ValueError("表头必须包含 1～16 个非空且不重复的列名")
    result=[]
    for i,row in enumerate(rows[1:],2):
        if len(row)!=len(headers): raise ValueError(f"第 {i} 行列数与表头不一致")
        if any(v=="FORMULA_NOT_SUPPORTED" or len(str(v or ""))>500 for v in row): raise ValueError(f"第 {i} 行含公式或过长内容，请粘贴为数值")
        result.append(["" if v is None else str(v) for v in row])
    return {"headers":headers,"rows":result,"rowCount":len(result), **_suggestions(headers)}
