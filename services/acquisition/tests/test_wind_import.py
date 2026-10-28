import base64
import json
import os
import tempfile
import unittest
from pathlib import Path

from blade_acquisition.wind_import import MINUTE_UNITS, merge_staged, preview, stage_preview


class WindImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, text, encoding="utf-8", name="data.csv"):
        source = self.root / ".wind-upload-test"
        source.write_bytes(text.encode(encoding))
        preview = stage_preview(self.root, {"filename": name, "inputFile": str(source)})
        return {"token": preview["token"], "mapping": preview["suggestedMapping"]}, preview

    def merge(self, files, units=None, offset="+08:00"):
        summary = merge_staged(self.root, {"files": files, "timezoneOffset": offset, "units": units or {"windSpeed": "m/s", "rpm": "rpm", "temperatureC": "C"}})
        return summary, json.loads((self.root / "wind-imports" / f"{summary['resultToken']}.merged.json").read_text())

    def test_exact_join_preserves_missing_and_chinese_encoding(self):
        wind, preview = self.stage("风机,时间,风速\nR018,2025-12-23 09:00:00,7.6\nR018,2025-12-23 09:00:01,0\n", "gb18030")
        rpm, _ = self.stage("风机,时间,轮毂转速\nR018,2025-12-23 09:00:01,6.9\n")
        temp, _ = self.stage("风机,时间,外界温度\nR018,2025-12-23 09:00:00,-13.6\n")
        summary, rows = self.merge([wind, rpm, temp])
        self.assertEqual(preview["encoding"], "GB18030")
        self.assertEqual(summary["rowCount"], 2)
        self.assertEqual(summary["matchedRowCount"], 1)
        self.assertEqual(rows[0], {"time": "2025-12-23T01:00:00.000Z", "turbineCode": "R018", "windSpeed": 7.6, "temperatureC": -13.6})
        self.assertEqual(rows[1]["windSpeed"], 0)
        self.assertEqual(rows[1]["rpm"], 6.9)

    def test_units_required_and_conversion(self):
        item, _ = self.stage("time,turbineCode,windSpeed,powerKw,temperatureC\n2025-12-23T00:00:00Z,R018,36,1000,32\n")
        with self.assertRaisesRegex(ValueError, "原始单位"):
            self.merge([item], {"windSpeed": "m/s"})
        summary, rows = self.merge([item], {"windSpeed": "km/h", "powerKw": "W", "temperatureC": "F"})
        self.assertEqual(rows[0]["windSpeed"], 10)
        self.assertEqual(rows[0]["powerKw"], 1)
        self.assertEqual(rows[0]["temperatureC"], 0)
        self.assertEqual(rows[0]["time"], "2025-12-23T00:00:00.000Z")
        self.assertEqual(summary["matchedRowCount"], 0)

    def test_conflicting_metric_duplicate_and_invalid_time_rejected(self):
        first, _ = self.stage("time,turbineCode,rpm\n2025-12-23 09:00:00,R018,6\n")
        second, _ = self.stage("time,turbineCode,rpm\n2025-12-23 09:00:00,R018,7\n")
        with self.assertRaisesRegex(ValueError, "重复"):
            self.merge([first, second])
        with self.assertRaisesRegex(ValueError, "重复"):
            self.merge([first, first])
        bad, _ = self.stage("time,turbineCode,rpm\n2025-02-30 09:00:00,R018,6\n")
        with self.assertRaisesRegex(ValueError, "时间格式"):
            self.merge([bad])

    def test_token_scope_expiry_and_invalid_mapping(self):
        item, preview = self.stage("time,turbineCode,rpm\n2025-12-23 09:00:00,R018,6\n")
        other = self.root / "other-account"
        other.mkdir()
        with self.assertRaisesRegex(ValueError, "过期"):
            merge_staged(other, {"files": [item], "timezoneOffset": "+08:00", "units": {"rpm": "rpm"}})
        with self.assertRaisesRegex(ValueError, "标识无效"):
            self.merge([{**item, "token": "../escape"}])
        with self.assertRaisesRegex(ValueError, "同一列"):
            self.merge([{**item, "mapping": {"time": "time", "turbineCode": "turbineCode", "rpm": "time"}}])
        # Failed confirmation can retry with the same token; success does not mutate the original stage.
        self.assertEqual(self.merge([item])[0]["rowCount"], 1)
        path = self.root / "wind-imports" / f"{preview['token']}.json"
        os.utime(path, (1, 1))
        with self.assertRaisesRegex(ValueError, "过期"):
            self.merge([item])

    def test_preview_is_bounded_and_missing_value_is_not_zero(self):
        item, preview = self.stage("time,turbineCode,rpm,temperatureC\n" + "".join(f"2025-12-23 09:00:{i:02d},R018,,0\n" for i in range(20)))
        self.assertEqual(len(preview["rows"]), 5)
        self.assertEqual(preview["rowCount"], 20)
        summary, rows = self.merge([item])
        self.assertEqual(summary["metricCounts"]["rpm"], 0)
        self.assertTrue(all("rpm" not in row for row in rows))
        self.assertTrue(all(row["temperatureC"] == 0 for row in rows))

    def test_standard_minute_export_maps_all_fields_and_keeps_identifier(self):
        text = ("名称,时间,风速,发电机有功功率,主轴转速,舱外温度,风向\n"
                "006#,2026-10-18 00:00:00,6.350000,3145.989990,8.740000,0.660000,-91.279999\n"
                "006#,2026-10-18 00:01:00,0,-41.200001,0.14,-3.09,171.889999\n")
        item, staged = self.stage(text, "gb18030", "006#_20261018_20261018_minute.csv")
        self.assertEqual(staged["sourceFormat"], "turbine-minute-v1")
        self.assertEqual(staged["suggestedUnits"], MINUTE_UNITS)
        self.assertEqual(staged["suggestedMapping"], {"time": "时间", "turbineCode": "名称", "windSpeed": "风速",
            "powerKw": "发电机有功功率", "rpm": "主轴转速", "temperatureC": "舱外温度", "windDirection": "风向"})
        self.assertEqual(staged["windDirectionReference"], "unspecified")
        summary, rows = self.merge([item], staged["suggestedUnits"])
        self.assertEqual(summary["matchedRowCount"], 2)
        self.assertEqual(summary["metricCounts"], {field: 2 for field in MINUTE_UNITS})
        self.assertEqual(rows[0], {"time": "2026-10-17T16:00:00.000Z", "turbineCode": "006#", "windSpeed": 6.35,
            "powerKw": 3145.98999, "rpm": 8.74, "temperatureC": 0.66, "windDirection": -91.279999})
        self.assertEqual(rows[1]["powerKw"], -41.200001)
        self.assertEqual(rows[1]["temperatureC"], -3.09)
        self.assertEqual(rows[1]["windDirection"], 171.889999)
        self.assertEqual(summary["windDirectionReference"], "unspecified")
        self.assertEqual(summary["sources"][0]["sourceFormat"], "turbine-minute-v1")
        self.assertEqual(summary["sources"][0]["windDirectionReference"], "unspecified")

    def test_unit_suggestion_does_not_bypass_explicit_confirmation(self):
        item, staged = self.stage("名称,时间,风速,发电机有功功率,主轴转速,舱外温度,风向\n006#,2026-10-18 00:00:00,6,3000,8,0,-91\n")
        with self.assertRaisesRegex(ValueError, "原始单位"):
            merge_staged(self.root, {"files": [item], "timezoneOffset": "+08:00", "units": {}})
        self.assertEqual(self.merge([item], staged["suggestedUnits"])[0]["rowCount"], 1)
        _, old = self.stage("风机,时间,当前风速\nR018,2025-12-23 09:00:00,7.6\n")
        self.assertEqual(old["suggestedUnits"], {})
        self.assertNotIn("sourceFormat", old)

    def test_signed_direction_bounds_are_retained_without_modulo(self):
        for value in (-360, -180, -91.279999, 0, 180, 359.9, 360):
            item, _ = self.stage(f"名称,时间,风向\n006#,2026-10-18 00:00:00,{value}\n")
            summary, rows = self.merge([item], {"windDirection": "deg"})
            self.assertEqual(rows[0]["windDirection"], value)
            self.assertEqual(summary["windDirectionReference"], "unspecified")
        for value in (-360.01, 360.01, "NaN", "Infinity"):
            item, _ = self.stage(f"名称,时间,风向\n006#,2026-10-18 00:00:00,{value}\n")
            with self.assertRaisesRegex(ValueError, "windDirection 超出范围"):
                self.merge([item], {"windDirection": "deg"})

    def test_new_aliases_keep_missing_distinct_from_zero(self):
        item, _ = self.stage("名称,时间,主轴转速,舱外温度,风向\n006#,2026-10-18 00:00:00,,0,\n006#,2026-10-18 00:01:00,0,,0\n")
        summary, rows = self.merge([item], {"rpm": "rpm", "temperatureC": "C", "windDirection": "deg"})
        self.assertNotIn("rpm", rows[0]); self.assertNotIn("windDirection", rows[0])
        self.assertEqual(rows[0]["temperatureC"], 0)
        self.assertEqual(rows[1]["rpm"], 0); self.assertEqual(rows[1]["windDirection"], 0)
        self.assertNotIn("temperatureC", rows[1])
        self.assertEqual(summary["matchedRowCount"], 0)

    def test_legacy_preview_identifies_new_format_without_rewriting_cells(self):
        text = "名称,时间,风速,发电机有功功率,主轴转速,舱外温度,风向\n006#,2026-10-18 00:00:00,6.350000,-41.200001,8.740000,0.660000,-91.279999\n"
        result = preview({"filename": "006#_minute.csv", "base64": base64.b64encode(text.encode("gb18030")).decode("ascii")})
        self.assertEqual(result["sourceFormat"], "turbine-minute-v1")
        self.assertEqual(result["rows"][0][0], "006#")
        self.assertEqual(result["rows"][0][-1], "-91.279999")
        self.assertEqual(result["suggestedUnits"], MINUTE_UNITS)


if __name__ == "__main__":
    unittest.main()
