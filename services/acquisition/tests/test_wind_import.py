import json
import os
import tempfile
import unittest
from pathlib import Path

from blade_acquisition.wind_import import merge_staged, stage_preview


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


if __name__ == "__main__":
    unittest.main()
