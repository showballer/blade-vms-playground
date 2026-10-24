// Pure coordinate and snapshot contracts. No bridge, local storage or hardware.
import assert from "node:assert/strict";
import type { FieldAxisFeedback, FieldStatus } from "./field-types";
import { createWorkOrigin, matchingWorkOrigin, readSavedWorkOrigins, revalidateWorkOrigin, recoverCalculatedWorkOrigin, toWorkAngle, toDeviceAngle, workAngleBounds, type FieldWorkOrigin } from "./field-turntable-origin";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const axis = (angle: number, limit: number, origin: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0,
  actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 3, command_counts_per_rev: 10000, encoder_bits: 17,
  flags: 3, fault: 0, origin_counts: origin, home_phase: 0, observedAt: 1000, referenceAngleDeg: 0,
  guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const ready = (): FieldStatus => ({ service: { state: "ready", dllConfigured: true, generation: 2 }, state: "idle",
  turntable: { state: "checked", port: "COM3", connected: false, motionCapability: { supported: true,
    mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: { state: 0, fault: 0 } },
    feedback: { motorRpm: 0, outputRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0,
      axes: { "1": axis(25, 35, 10), "2": axis(-5, 180, 20) } } } });
const changed = (mutate: (status: FieldStatus) => void) => { const status = ready(); mutate(status); return status; };
const axes = (status: FieldStatus) => status.turntable!.feedback!.axes!;
const near = (a: number | null, b: number, tolerance = 1e-10) => assert.ok(a !== null && Math.abs(a - b) <= tolerance, `${a} != ${b}`);

check("fresh读取只建立软件作业原点，保留设备姿态、参考和全部元数据", () => {
  const status = ready(), before = structuredClone(status);
  const origin = createWorkOrigin(status, "COM3");
  assert.deepEqual(status, before);
  assert.equal(origin.port, "COM3"); assert.equal(origin.generation, 2);
  assert.equal(origin.axis1AngleDeg, 25); assert.equal(origin.axis2AngleDeg, -5);
  assert.equal(origin.referenceSignature, JSON.stringify([[10, 3, 10000, 17], [20, 3, 10000, 17]]));
  assert.equal(toWorkAngle(25, 1, origin), 0); assert.equal(toWorkAngle(-5, 2, origin), 0);
  assert.equal(toDeviceAngle(0, 1, origin), 25); assert.equal(toDeviceAngle(0, 2, origin), -5);
  assert.strictEqual(matchingWorkOrigin(origin, status, "COM3"), origin);
  for (const port of ["COM6", "/dev/cu.usbserial-1140"]) {
    const other = changed(status => { status.turntable!.port = port; });
    assert.equal(createWorkOrigin(other, port).port, port);
  }
});

check("角度双向转换无原点保持原值、缺值保持未知、消除浮点噪声与负零", () => {
  const origin = { ...createWorkOrigin(ready(), "COM3"), axis1AngleDeg: .1, axis2AngleDeg: -.3 };
  assert.equal(toWorkAngle(.3, 1, origin), .2); assert.equal(toDeviceAngle(.2, 1, origin), .3);
  for (const axis of [1, 2] as const) for (const absolute of [-35, -.1, 0, .1, .31, 25, 35])
    near(toDeviceAngle(toWorkAngle(absolute, axis, origin)!, axis, origin), absolute);
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(toWorkAngle(value, 1, origin), null);
  assert.equal(toWorkAngle(12.3, 1), 12.3); assert.equal(toDeviceAngle(12.3, 1), 12.3);
  assert.equal(toWorkAngle(12.3, 2, null), 12.3); assert.ok(Number.isNaN(toDeviceAngle(NaN, 1, origin)));
  assert.equal(toDeviceAngle(Infinity, 1, origin), Infinity, "Invalid targets remain invalid for the existing absolute validator");
  assert.ok(!Object.is(toWorkAngle(-0, 1), -0)); assert.ok(!Object.is(toDeviceAngle(-0, 1), -0));
});

check("作业范围平移设备包络，不能因归零扩大实际运动范围", () => {
  const origin = createWorkOrigin(ready(), "COM3");
  assert.deepEqual(workAngleBounds(1, origin), { min: -60, max: 10 });
  assert.deepEqual(workAngleBounds(2, origin), { min: -175, max: 185 });
  assert.deepEqual(workAngleBounds(1), { min: -35, max: 35 });
  assert.deepEqual(workAngleBounds(2), { min: -180, max: 180 });
  for (const axis of [1, 2] as const) {
    const bounds = workAngleBounds(axis, origin), limit = axis === 1 ? 35 : 180;
    assert.equal(toDeviceAngle(bounds.min, axis, origin), -limit);
    assert.equal(toDeviceAngle(bounds.max, axis, origin), limit);
    assert.ok(toDeviceAngle(bounds.max + .1, axis, origin) > limit);
  }
});

check("采集所有权、设备操作和待启动硬件轨迹阻止归零，历史点位阶段不锁死", () => {
  const patches: ((status: FieldStatus) => void)[] = [
    ...(["starting", "acquiring", "stopping"] as const).map(state => (status: FieldStatus) => { status.state = state; }),
    status => { status.receiver = { running: true }; }, status => { status.deviceBusy = true; }, status => { status.turntableBusy = true; },
  ];
  for (const mutate of patches) assert.throws(() => createWorkOrigin(changed(mutate), "COM3"));
  for (const state of ["idle", "error"] as const) {
    const old = changed(status => { status.state = state; status.receiver = { running: false };
      status.pointCycle = { state: "positioning", cycles: 1, dwellSeconds: 60, speedRpm: .2, pointCount: 4, cycle: 1, point: 1, completedRecords: 0, totalRecords: 4 }; });
    assert.ok(createWorkOrigin(old, "COM3"));
    old.receiver!.running = true;
    assert.throws(() => createWorkOrigin(old, "COM3"));
  }
  for (const state of [1, 2, 3, 4, 5, 7]) assert.throws(() => createWorkOrigin(changed(status => {
    status.turntable!.motionCapability!.status = { state, fault: state === 7 ? 13 : 0 };
  }), "COM3"));
  for (const state of [0, 6, 8]) {
    assert.ok(createWorkOrigin(changed(status => { status.turntable!.motionCapability!.status = { state, fault: state === 8 ? 1 : 0 }; }), "COM3"));
    assert.throws(() => createWorkOrigin(changed(status => { status.turntable!.motionCapability!.status = { state, fault: 13 }; }), "COM3"));
  }
});

check("串口、服务代际、警告或未核实停止状态无效时不能创建原点", () => {
  for (const port of ["", "COM0", "com3", "COM3 ", "COM4"]) assert.throws(() => createWorkOrigin(ready(), port));
  for (const generation of [undefined, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => createWorkOrigin(changed(status => { status.service.generation = generation; }), "COM3"));
  for (const mutate of [
    (status: FieldStatus) => { status.service.state = "error"; },
    (status: FieldStatus) => { status.deviceWarning = "激光状态未知"; },
    (status: FieldStatus) => { status.turntableWarning = "停止待确认"; },
    (status: FieldStatus) => { status.turntable!.state = "unknown"; },
    (status: FieldStatus) => { status.turntable!.error = "通信异常"; },
    (status: FieldStatus) => { Object.assign(status.turntable!, { stopConfirmed: false }); },
  ]) assert.throws(() => createWorkOrigin(changed(mutate), "COM3"));
  for (const patch of [{ motorRpm: .1 }, { outputRpm: .1 }, { alarmCode: 1 }, { limitFlags: 1 }, { limitFlags: 2 }, { limitFlags: 4 }])
    assert.throws(() => createWorkOrigin(changed(status => { Object.assign(status.turntable!.feedback!, patch); }), "COM3"));
  // Old speed feedback may omit this optional extension. Real position feedback
  // still confirms both axes' reference, stopped state and absence of bit16.
  assert.ok(createWorkOrigin(changed(status => { status.turntable!.feedback!.limitFlags = null; }), "COM3"));
});

check("不能用伪造参考标志、无效反馈单位、故障、回零中或越界角度创建原点", () => {
  for (const axis of [1, 2]) for (const patch of [
    { flags: 0 }, { flags: 2 }, { flags: -1 }, { flags: 65537 }, { flags: 1.5 }, { flags: 19 },
    { motor_rpm: .1 }, { fault: 2 }, { home_phase: 1 }, { home_phase: 6 }, { output_angle_deg: null }, { output_angle_deg: NaN },
    { output_angle_deg: Infinity }, { output_angle_deg: axis === 1 ? 35.001 : 180.001 },
    { display_mode: 0 }, { command_counts_per_rev: 0 }, { origin_counts: NaN }, { encoder_bits: NaN },
  ]) assert.throws(() => createWorkOrigin(changed(status => { Object.assign(axes(status)[String(axis)], patch); }), "COM3"));
  for (const home_phase of [0, 7, 8]) assert.ok(createWorkOrigin(changed(status => { axes(status)["1"].home_phase = home_phase; }), "COM3"));
});

check("俯仰软限位必须保留，水平可无软限位，已开启范围仍严格核对", () => {
  assert.throws(() => createWorkOrigin(changed(status => { axes(status)["1"].guard.soft_enabled = false; }), "COM3"));
  const noHorizontalSoft = changed(status => {
    axes(status)["2"].flags = 1;
    Object.assign(axes(status)["2"].guard, { soft_enabled: false, minimum_deg: NaN, maximum_deg: NaN });
  });
  assert.ok(createWorkOrigin(noHorizontalSoft, "COM3"));
  for (const axis of [1, 2]) {
    assert.throws(() => createWorkOrigin(changed(status => { axes(status)[String(axis)].flags = 1; }), "COM3"));
    for (const [minimum_deg, maximum_deg] of [[NaN, 35], [-35, Infinity], [10, -10], [0, 0]])
      assert.throws(() => createWorkOrigin(changed(status => { Object.assign(axes(status)[String(axis)].guard, { minimum_deg, maximum_deg }); }), "COM3"));
  }
  assert.throws(() => createWorkOrigin(changed(status => { axes(status)["1"].guard.maximum_deg = 20; }), "COM3"));
  assert.throws(() => createWorkOrigin(changed(status => { axes(status)["1"].guard.minimum_deg = -36; }), "COM3"));
  assert.throws(() => createWorkOrigin(changed(status => { axes(status)["2"].guard.minimum_deg = 0; }), "COM3"));
});

check("匹配仅依赖相同设备参考与服务代际，运动中仍可显示相对角度", () => {
  const status = ready(), origin = createWorkOrigin(status, "COM3");
  const moving = changed(status => {
    status.state = "acquiring"; status.turntableBusy = true; status.turntable!.state = "positioning";
    Object.assign(status.turntable!, { stopConfirmed: false });
    axes(status)["1"].motor_rpm = 50; axes(status)["2"].motor_rpm = -25;
    axes(status)["1"].output_angle_deg = 27; axes(status)["2"].output_angle_deg = -4;
    status.turntable!.feedback!.motorRpm = 50;
  });
  assert.strictEqual(matchingWorkOrigin(origin, moving, "COM3"), origin);
  assert.equal(toWorkAngle(axes(moving)["1"].output_angle_deg, 1, origin), 2);
  assert.equal(toWorkAngle(axes(moving)["2"].output_angle_deg, 2, origin), 1);
  assert.strictEqual(matchingWorkOrigin(origin, changed(status => { status.turntable!.feedback!.limitFlags = null; }), "COM3"), origin);
});

check("参考、串口或代际失效与未知停止会使作业零点停止适用", () => {
  const origin = createWorkOrigin(ready(), "COM3");
  assert.equal(matchingWorkOrigin(undefined, ready(), "COM3"), null);
  assert.equal(matchingWorkOrigin(null, ready(), "COM3"), null); assert.equal(matchingWorkOrigin(origin, null, "COM3"), null);
  assert.equal(matchingWorkOrigin(origin, ready(), "COM4"), null);
  for (const mutate of [
    (status: FieldStatus) => { status.turntable!.port = "COM4"; },
    (status: FieldStatus) => { status.service.generation = 3; },
    (status: FieldStatus) => { status.service.state = "stopped"; },
    (status: FieldStatus) => { axes(status)["1"].origin_counts++; },
    (status: FieldStatus) => { axes(status)["2"].command_counts_per_rev++; },
    (status: FieldStatus) => { axes(status)["1"].flags = 2; },
    (status: FieldStatus) => { axes(status)["2"].output_angle_deg = null; },
    (status: FieldStatus) => { status.turntableWarning = "停止未知"; },
    (status: FieldStatus) => { status.turntable!.state = "unknown"; },
    (status: FieldStatus) => { Object.assign(status.turntable!, { stopConfirmed: false }); },
    (status: FieldStatus) => { axes(status)["2"].flags |= 16; },
    (status: FieldStatus) => { status.turntable!.feedback!.limitFlags = 2; },
  ]) assert.equal(matchingWorkOrigin(origin, changed(mutate), "COM3"), null);
  for (const patch of [{ generation: NaN }, { referenceSignature: "[]" }, { axis1AngleDeg: NaN }, { axis2AngleDeg: 181 }])
    assert.equal(matchingWorkOrigin({ ...origin, ...patch } as FieldWorkOrigin, ready(), "COM3"), null);
});

console.log(`PASS ${checks} work-origin coordinate and reference checks; no hardware used`);

check("保存坐标重载后必须fresh核验，不以新位置或新代际覆盖原点", () => {
  const origin = createWorkOrigin(ready(), "COM3");
  const stored = readSavedWorkOrigins(JSON.stringify({ version: 1, work: origin, optical: origin }));
  assert.equal(stored.optical!.axis1AngleDeg, 25);
  assert.equal(stored.optical!.verificationRequired, true);
  assert.equal(matchingWorkOrigin(stored.optical, ready(), "COM3"), null);
  const moved = changed(next => { next.service.generation = 8; axes(next)["1"].output_angle_deg = 3; axes(next)["2"].output_angle_deg = 4; });
  const verified = revalidateWorkOrigin(stored.optical!, moved, "COM3");
  assert.deepEqual([verified.axis1AngleDeg, verified.axis2AngleDeg], [25, -5]);
  assert.equal(verified.generation, 8); assert.equal(verified.verificationRequired, false);
  assert.strictEqual(matchingWorkOrigin(verified, moved, "COM3"), verified);
  axes(moved)["1"].origin_counts++;
  assert.throws(() => revalidateWorkOrigin(stored.optical!, moved, "COM3"), /参考位/);
  for (const raw of [null, "bad json", JSON.stringify({ version: 1, optical: { ...origin, axis1AngleDeg: 100 } })])
    assert.equal(readSavedWorkOrigins(raw).optical, null);
});

check("可恢复漏传返回参数的计算路线原点，不能从校准点或当前位置猜零点", () => {
  const status = ready(), signature = createWorkOrigin(status, "COM3").referenceSignature;
  status.pointCycle = { state: "complete", sessionId: "saved-task", cycles: 1, cycle: 1, point: 4, pointCount: 4, totalRecords: 4, completedRecords: 4, speedRpm: 5, dwellSeconds: 60 };
  const config = { mode: "automatic_stations", startAtCurrentPose: false, port: "COM3",
    geometry: { distanceM: 3.3, hubHeightDeltaM: .85, anchorRadiusM: .078, anchorAxis1AngleDeg: 12.696949650102738, anchorAxis2AngleDeg: -16.73, axis1Sign: 1 } };
  status.recording = { pointCycle: { sessionId: "saved-task", referenceSignature: signature }, turntable: { config } } as unknown as FieldStatus["recording"];
  const origin = recoverCalculatedWorkOrigin(status)!;
  near(origin.axis1AngleDeg, -.47); near(origin.axis2AngleDeg, -16.73);
  assert.notEqual(origin.axis1AngleDeg, axes(status)["1"].output_angle_deg);
  const idealPitch = Math.atan2(.85 - .078, 3.3) * 180 / Math.PI;
  Object.assign(config.geometry, { pitchAngleScale: .896932, anchorAxis1AngleDeg: -.47 + .896932 * idealPitch });
  near(recoverCalculatedWorkOrigin(status)!.axis1AngleDeg, -.47);
  for (const pitchAngleScale of [null, 0, 1.6, NaN]) {
    Object.assign(config.geometry, { pitchAngleScale });
    assert.equal(recoverCalculatedWorkOrigin(status), null);
  }
  Object.assign(config.geometry, { pitchAngleScale: .896932 });
  config.startAtCurrentPose = true;
  assert.equal(recoverCalculatedWorkOrigin(status), null);
  config.startAtCurrentPose = false; status.pointCycle.sessionId = "another-task";
  assert.equal(recoverCalculatedWorkOrigin(status), null);
});
