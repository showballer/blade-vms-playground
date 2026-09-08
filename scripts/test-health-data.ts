import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { applyAlertReview, defaultThresholds, healthDemoMetrics, healthGrade, healthMetricSummary, optionalHealthLimits, thresholdValues, validateThresholds } from "../packages/ui/src/health-data";
const tests: { name: string; result: string }[] = [];
function check(name: string, fn: () => void) { fn(); tests.push({ name, result: "pass" }); console.log("PASS " + name); }
check("正常、注意、预警、报警包含精确边界与负向漂移", () => {
  assert.deepEqual([0, 1.19, 1.2, 1.59, 1.6, 1.99, 2, -2].map(v => healthGrade(v, 2, defaultThresholds)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(healthGrade(NaN, 2, defaultThresholds), null);
});
check("拒绝不递增分级、非数值与非正阈值", () => {
  for (const patch of [{ rms: 0 }, { band: NaN }, { frequency: "5" }, { attentionRatio: 0 }, { attentionRatio: .9 }, { warningRatio: 1 }, { attentionRatio: .8 }]) assert.throws(() => validateThresholds({ ...defaultThresholds, ...patch }));
});
check("旧配置只补注意比例，保留原阈值，不用整体默认值", () => {
  assert.deepEqual(thresholdValues({ rms: 9, frequency: 10, band: .8, warningRatio: .4 }), { rms: 9, frequency: 10, band: .8, warningRatio: .4, attentionRatio: .3 });
  assert.throws(() => thresholdValues({ warningRatio: .8 }));
});
check("扩展阈值可配置、清空，非法值拒绝，旧配置不静默补默认值", () => {
  const extra = { peak: 4, peakToPeak: 7, mainAmplitude: 1 };
  assert.deepEqual(validateThresholds({ ...defaultThresholds, ...extra }), { ...defaultThresholds, ...extra });
  for (const key of optionalHealthLimits) {
    for (const value of [0, -1, "1", "", NaN, Infinity]) assert.throws(() => validateThresholds({ ...defaultThresholds, [key]: value }));
    assert.deepEqual(validateThresholds({ ...defaultThresholds, [key]: null }), defaultThresholds);
  }
});
check("六指标按各自阈值分级，负频漂按绝对值，缺失项不能宣称全部正常", () => {
  const b = { object: "风机叶片A", rms: 1.42 };
  const partial = healthDemoMetrics(b, defaultThresholds);
  assert.deepEqual(partial.map(m => m.key), ["rms", "frequency", "band", "peak", "peakToPeak", "mainAmplitude"]);
  assert.deepEqual(partial.map(m => m.grade), [2, 2, 3, null, null, null]);
  assert.equal(partial[1].value, -4.2);
  assert.deepEqual(healthMetricSummary(partial), { grade: 3, configured: 3, total: 6, complete: false, label: "报警" });
  const complete = healthDemoMetrics(b, { ...defaultThresholds, peak: 3.4, peakToPeak: 6.6, mainAmplitude: .83 });
  assert.equal(healthMetricSummary(complete).configured, 6); assert.deepEqual(complete.slice(3).map(m => m.grade), [3, 3, 3]);
  assert.equal(healthMetricSummary(healthDemoMetrics(b, { ...defaultThresholds, rms: 100, frequency: 100, band: 100 })).label, "未完整判定");
  assert.equal(healthMetricSummary(healthDemoMetrics(b)).label, "未判定");
});
check("复核身份与时间由服务端覆盖，历史字段不能伪造", () => {
  const result = applyAlertReview({ status: "待复核" }, { status: "已确认", reviewNote: "  检查完成  ", reviewer: "伪造", reviewerId: "root", reviewedAt: "1900", reviewHistory: [{ note: "伪造" }] }, { id: "qa", name: "分析员" }, "2026-09-08T00:00:00.000Z");
  assert.equal(result.reviewer, "分析员"); assert.equal(result.reviewerId, "qa"); assert.equal(result.reviewHistory.length, 1); assert.equal(result.reviewNote, "检查完成");
  assert.equal(result.reviewedAt, "2026-09-08T00:00:00.000Z");
  const retry = applyAlertReview(result, { ...result, reviewer: "伪造", reviewHistory: [] }, { id: "other", name: "其他人" }, "later"); assert.deepEqual(retry, result);
  const closed = applyAlertReview(result, { ...result, status: "已关闭", reviewNote: "已处置" }, { id: "other", name: "其他人" }, "later"); assert.equal(closed.reviewHistory.length, 2); assert.equal(result.reviewHistory.length, 1);
});
check("状态变更必须有说明，普通编辑保留既有复核记录", () => {
  assert.throws(() => applyAlertReview({ status: "待复核" }, { status: "已关闭" }, { id: "q", name: "q" }, "now"));
  assert.equal(applyAlertReview(null, { status: "待复核", reviewer: "fake" }, { id: "q", name: "q" }, "now").reviewer, undefined);
});
mkdirSync("artifacts", { recursive: true }); writeFileSync("artifacts/health-core-results.json", JSON.stringify({ time: new Date().toISOString(), tests }, null, 2));
