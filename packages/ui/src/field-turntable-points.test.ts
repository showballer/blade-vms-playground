import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSharedTurntablePoints, saveSharedTurntablePoints, sharedTurntablePointKey,
  normalizeSharedTurntablePoints, pointReferenceSignature, turntableReferenceSignature, turntablePointMotionError } from "./field-turntable-points";
import type { FieldAxisFeedback } from "./field-types";
import { isTurntablePort, normalizeTurntablePort } from "./field-turntable-port";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

test("renderer and Electron share strict Windows/macOS serial-name boundaries", () => {
  const cases = JSON.parse(readFileSync("scripts/fixtures/turntable-ports.json", "utf8"));
  const require = createRequire(`${process.cwd()}/package.json`);
  const bridge = require("./apps/desktop/electron/field-turntable-port.cjs");
  for (const port of cases.valid) { assert.equal(isTurntablePort(port), true, port); assert.equal(bridge.isTurntablePort(port), true, port); }
  for (const port of [...cases.invalid, `/dev/cu.${"a".repeat(129)}`]) { assert.equal(isTurntablePort(port), false, String(port)); assert.equal(bridge.isTurntablePort(port), false, String(port)); }
  assert.equal(normalizeTurntablePort(" com6 "), "COM6");
  assert.equal(normalizeTurntablePort(" /dev/cu.SLAB_USBtoUART "), "/dev/cu.SLAB_USBtoUART");
});

const axis: FieldAxisFeedback = { output_angle_deg: 0, motor_rpm: 0, actual_counts: 99, commanded_counts: 99,
  error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17, flags: 1, fault: 0,
  origin_counts: 0, home_phase: 0, observedAt: 1, referenceAngleDeg: 25,
  guard: { soft_enabled: true, hardware_enabled: true, minimum_deg: -35, maximum_deg: 35 } };
const axes = { "1": axis, "2": { ...axis, referenceAngleDeg: 0, guard: { ...axis.guard, minimum_deg: -180, maximum_deg: 180 } } };
const signature = turntableReferenceSignature(axes)!;
const point = { pointId: "saved-point", name: "B2-P3", axis1AngleDeg: 20, axis2AngleDeg: -30,
  axis1RawCounts: 100, axis2RawCounts: -150, recordedAt: 1792300000000, port: "COM6" };
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("Mac 点位跨页写回保留大小写，换设备或参考位仍禁止回位", () => {
  const port = "/dev/cu.SLAB_USBtoUART";
  const local = storage({ [sharedTurntablePointKey]: JSON.stringify([{ ...point, port, references: signature }]) });
  const acquired = loadSharedTurntablePoints(local);
  saveSharedTurntablePoints(local, acquired);
  const manual = loadSharedTurntablePoints(local)[0];
  assert.equal(manual.port, port);
  assert.equal(manual.referenceSignature, signature);
  assert.equal(turntablePointMotionError(manual, axes, port), "");
  assert.match(turntablePointMotionError(manual, axes, port.toLowerCase()), /串口/);
  assert.match(turntablePointMotionError(manual, { ...axes, "2": { ...axes["2"], origin_counts: 1 } }, port), /参考位/);
});

test("旧独立点位经采集页再回独立页，串口/参考/原始计数/自定义字段都保留", () => {
  const local = storage({ [sharedTurntablePointKey]: JSON.stringify([{ ...point, references: signature, note: "现场点位", port: " com6 " }]) });
  const acquisition = loadSharedTurntablePoints(local);
  assert.equal(acquisition[0].referenceSignature, signature);
  assert.equal(acquisition[0].references, signature);
  assert.equal(acquisition[0].port, "COM6");
  saveSharedTurntablePoints(local, acquisition);
  const manual = loadSharedTurntablePoints(local);
  assert.deepEqual(manual, acquisition);
  assert.equal(manual[0].axis2RawCounts, -150);
  assert.equal((manual[0] as unknown as { note: string }).note, "现场点位");
  assert.equal(turntablePointMotionError(manual[0], axes, "COM6"), "");
  saveSharedTurntablePoints(local, manual);
  assert.deepEqual(loadSharedTurntablePoints(local), acquisition);
});

test("采集标定点经独立页再回采集页，叶片与圆周元数据及规范签名不变", () => {
  const source = { ...point, referenceSignature: signature, bladeIndex: 2, bladePointIndex: 3, circleIndex: 5, circleStepDeg: 60 };
  const local = storage({ [sharedTurntablePointKey]: JSON.stringify([source]) });
  const manual = loadSharedTurntablePoints(local);
  assert.equal(manual[0].references, signature);
  assert.equal(turntablePointMotionError(manual[0], axes, "COM6"), "");
  saveSharedTurntablePoints(local, manual);
  const acquisition = loadSharedTurntablePoints(local)[0];
  for (const [key, value] of Object.entries(source)) assert.deepEqual(acquisition[key as keyof typeof acquisition], value);
  assert.equal(pointReferenceSignature(acquisition), signature);
});

test("v1两种点位库迁移后多次写回幂等，迁移不替缺失的串口/参考制造当前值", () => {
  const legacyWithoutPort = { ...point, port: undefined, referenceSignature: signature };
  const local = storage({ "blade-turntable-points-v1": JSON.stringify([legacyWithoutPort]),
    "blade-turntable-manual-points-v1": JSON.stringify([{ ...point, pointId: "manual", references: signature }]) });
  const loaded = loadSharedTurntablePoints(local);
  assert.equal(loaded.length, 2);
  assert.match(turntablePointMotionError(loaded[0], axes, "COM6"), /历史点位缺少有效串口/);
  assert.equal(loaded[0].port, undefined);
  saveSharedTurntablePoints(local, loaded);
  assert.deepEqual(loadSharedTurntablePoints(local), loaded);
  const missing = normalizeSharedTurntablePoints([point])[0];
  assert.equal(missing.referenceSignature, undefined);
  assert.match(turntablePointMotionError(missing, axes, "COM6"), /缺少有效参考位/);
});

test("原点/显示模式/计数单位/编码器位数变化及切换串口都阻止运动", () => {
  const saved = normalizeSharedTurntablePoints([{ ...point, references: signature }])[0];
  assert.match(turntablePointMotionError(saved, axes, "COM7"), /串口/);
  for (const key of ["origin_counts", "display_mode", "command_counts_per_rev", "encoder_bits"] as const) {
    const changed = { ...axes, "2": { ...axes["2"], [key]: axes["2"][key] + 1 } };
    assert.match(turntablePointMotionError(saved, changed, "COM6"), /参考位或反馈单位已变化/, key);
  }
  assert.match(turntablePointMotionError(saved, undefined, "COM6"), /读取两轴有效参考位/);
  assert.match(turntablePointMotionError(saved, { "1": axis }, "COM6"), /读取两轴有效参考位/);
});

test("损坏、非整数或相互冲突的签名不会被归一化成可运动点位", () => {
  const changed = JSON.stringify([[1, 3, 10000, 17], [0, 3, 10000, 17]]);
  for (const metadata of [{ referenceSignature: signature, references: changed },
    { referenceSignature: "bad", references: signature }, { referenceSignature: "[[0.5,3,10000,17],[0,3,10000,17]]" },
    { references: "[null,null]" }, { referenceSignature: "" }]) {
    const normalized = normalizeSharedTurntablePoints([{ ...point, ...metadata }])[0];
    assert.equal(pointReferenceSignature(normalized), undefined);
    assert.match(turntablePointMotionError(normalized, axes, "COM6"), /有效参考位.*冲突/);
    for (const [key, value] of Object.entries(metadata)) assert.equal(normalized[key as "references" | "referenceSignature"], value);
  }
});

test("参考签名仅接受完整有效两轴，角度缺失/越界及当前软限位继续拦截", () => {
  assert.equal(turntableReferenceSignature({ ...axes, "2": { ...axes["2"], output_angle_deg: null } }), undefined);
  const saved = normalizeSharedTurntablePoints([{ ...point, referenceSignature: signature }])[0];
  assert.match(turntablePointMotionError({ ...saved, axis1AngleDeg: 35.01 }, axes, "COM6"), /轴1.*±35/);
  assert.match(turntablePointMotionError({ ...saved, axis2AngleDeg: null }, axes, "COM6"), /轴2有效角度/);
  assert.match(turntablePointMotionError(saved, { ...axes, "1": { ...axis, guard: { ...axis.guard, maximum_deg: 10 } } }, "COM6"), /当前软限位/);
});
