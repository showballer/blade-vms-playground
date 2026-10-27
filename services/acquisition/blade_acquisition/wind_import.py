"""Bounded table preview. Column selection and unit confirmation precede persistence."""
import base64
import csv
import io
from .web_rotation import workbook_tables


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
    return {"headers":headers,"rows":result,"rowCount":len(result)}
