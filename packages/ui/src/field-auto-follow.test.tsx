// Offline contracts only. No device bridge or production Electron preload is loaded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldAutoFollow, FieldTurntableWorkspace, autoFollowAnchorFromStatus, autoFollowAnchorKey, autoFollowBlockers, autoFollowCollection, autoFollowCollectionContext, autoFollowOpticalOriginError, autoFollowPointLengthError, readAutoFollowDraft } from "./field-auto-follow";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { fieldTurntableMotionMode, type FieldAxisFeedback, type FieldConfig, type FieldStatus } from "./field-types";
import { FieldTurntableManual } from "./field-turntable";
import { FieldTurntableOriginControl } from "./field-turntable-origin-control";
import { createWorkOrigin, matchingWorkOrigin } from "./field-turntable-origin";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const axis = (angle: number, limit: number): FieldAxisFeedback => ({ output_angle_deg: angle, motor_rpm: 0, actual_counts: 0, commanded_counts: 0, error_counts: 0, display_mode: 0, command_counts_per_rev: 10000, encoder_bits: 16, flags: 0, fault: 0, origin_counts: 0, home_phase: 0, observedAt: 1792400000, referenceAngleDeg: 0, guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -limit, maximum_deg: limit } });
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true, generation: 1 }, state: "idle", turntable: { state: "idle", port: "COM3", connected: true, feedback: { outputRpm: 0, motorRpm: 0, alarmCode: 0, limitFlags: 0, positionRaw: 0, axes: { "1": axis(10, 35), "2": axis(0, 180) } } } };
const config: FieldConfig = { name: "叶片点位采集", deviceIp: "198.51.100.10", hostIp: "198.51.100.11", object: "", turbine: "", point: "" };
const props = { config, onConfig: () => {}, status: ready, disabled: false, request: async <T,>(): Promise<T> => { throw new Error("No hardware in renderer test"); }, onStatus: () => {}, onRecords: () => {}, onService: () => {} };

check("上次换点阶段不会锁住空闲或异常后的配置，仍运行的接收线程继续锁定", () => {
  for (const state of ["idle", "error"] as const) {
    const status: FieldStatus = { ...ready, state, receiver: { running: false }, pointCycle: { state: "positioning", cycles: 1,
      pointCount: 2, point: 1, cycle: 1, completedRecords: 0, totalRecords: 2, speedRpm: 5, dwellSeconds: 60 } };
    const input = (value: FieldStatus) => renderToStaticMarkup(<FieldAutoFollow {...props} status={value} />)
      .match(/<input[^>]*aria-label="叶轮每圈时间 · s"[^>]*>/)?.[0] || "";
    assert.ok(input(status)); assert.doesNotMatch(input(status), /disabled/);
    status.receiver!.running = true;
    assert.match(input(status), /disabled/);
  }
});

check("生产入口包含手动、自动和分段三个标签，没有试运行与模拟开关", () => {
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} />);
  assert.ok(html.includes("手动控制")); assert.ok(html.includes("自动跟随")); assert.ok(html.includes("分段采集"));
  assert.ok(!html.includes("单点跟随")); assert.ok(!html.includes("转速试运行")); assert.ok(!html.includes("模拟采集"));
  const source = readFileSync(new URL("./field-desktop.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("FieldSinglePoint")); assert.ok(!source.includes("field-debug-toggle"));
  assert.ok(source.includes('source="device" config={config}'));
  assert.ok(source.includes("FieldBladeSummary"));
});
check("默认分段优先且测量、模式与设置按顺序排布", () => {
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} />);
  const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]*>/g, ""));
  assert.deepEqual(tabs.slice(0, 3), ["分段采集", "自动跟随", "手动控制"]);
  assert.match(html, /data-active="segmented"/);
  assert.ok(html.indexOf("设置归零") < html.indexOf("测量设置"));
  assert.ok(html.indexOf("测量设置") < html.indexOf('aria-label="转盘作业方式"'));
  assert.ok(html.indexOf("分段采集配置") < html.indexOf('class="field-card field-turntable-settings-card"'));
  const manual = renderToStaticMarkup(<FieldTurntableWorkspace {...props} routeMode="manual" />);
  assert.ok(manual.includes('aria-label="打开转盘设置"'));
});
check("分段采集复用测量与五测点配置，提供单段点数、移动间隔和逐点定位", () => {
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} routeMode="segmented" onPositionTarget={() => {}} />);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>.*?分段采集/);
  assert.equal((html.match(/aria-label="叶片长度 · m"/g) || []).length, 1, "Only one calculated configuration editor owns shared geometry");
  for (const label of ["分段采集配置", "单点采集", "两点采集", "圆周移动间隔", "生成5个测点", "校准0°点"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /aria-label="每个测点采集轮数"/);
  for (const removed of ["P1 圆周起点", "移动P1到预设位置", "当前分段路线", "不上传整圈预置路径", "最长点位间运动估算"]) assert.ok(!html.includes(removed), removed);
  assert.ok(!html.includes("任务完成后自动回到作业原点"));
  assert.doesNotMatch(html, /aria-label="进入确认时间 · ms"/);
  assert.doesNotMatch(html, /aria-label="离开确认时间 · ms"/);
  assert.equal((html.match(/class="field-card field-drive-profile"/g) || []).length, 0, "Drive parameters open only in the turntable settings dialog");
  assert.ok(html.includes("转盘设置"));
  assert.doesNotMatch(html, /aria-label="点位移动速度 · rpm"/);
  assert.ok(!html.includes("填入快速预设"));
  const nativeStatus: FieldStatus = { ...ready, turntable: { ...ready.turntable!, motionCapability: { supported: true, probe: "confirmed", mode: "dual_axis_timed", pointMode: "drive_internal", protocol: "0x30-0x36", preloadedPoints: true, status: {} } } };
  const nativeHtml = renderToStaticMarkup(<FieldAutoFollow {...props} status={nativeStatus} connectionPort="COM3" routeMode="segmented" />);
  assert.ok(!nativeHtml.includes("加速时间 · PA40"));
  assert.doesNotMatch(nativeHtml, /aria-label="旧轨迹加速度上限 · °\/s²"/);
  const busyHtml = renderToStaticMarkup(<FieldAutoFollow {...props} routeMode="segmented" disabled onPositionTarget={() => {}} />);
  assert.match(busyHtml, /<input[^>]*aria-label="设备至叶轮平面 · m"[^>]*disabled/);
});
check("默认30秒模型只生成输入，没有参考位与隐式开机请求", () => {
  const restored = readAutoFollowDraft(null);
  assert.equal(restored.draft.periodSeconds, 30); assert.equal(restored.draft.bladeId, "2");
  assert.equal(restored.draft.distanceM, 2.86); assert.equal(restored.draft.hubHeightDeltaM, 1.46); assert.equal(restored.draft.points[0].radiusM, .31);
  const html = renderToStaticMarkup(<FieldAutoFollow {...props} />);
  assert.ok(html.includes('aria-label="校准测点1"'));
  assert.ok(!html.includes("开始自动采集")); assert.ok(html.includes("前往数据采集"));
  assert.ok(!html.includes('class="field-card field-auto-anchor"')); assert.ok(!html.includes("未校准时按尺寸计算"));
  assert.ok(html.includes("将测点放在旋转中心正下方并瞄准"));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 0);
  assert.doesNotMatch(html, /aria-label="测试：未停稳时判定叶片"/);
  assert.doesNotMatch(html, /aria-label="测试：未停稳时判定叶片"[^>]*checked/);
  assert.ok(!html.includes("6→9"));
  assert.ok(html.includes("顺时针")); assert.ok(html.includes("逆时针"));
  assert.match(html, /aria-label="叶轮每圈时间 · s"[^>]*min="0"/);
  assert.doesNotMatch(html, /aria-label="换点加速度上限 · °\/s²"/);
  assert.doesNotMatch(html, /aria-label="运动中跟随误差上限 · °"/);
  assert.ok(!html.includes("待校准")); assert.ok(!html.includes("设备与服务设置")); assert.ok(!html.includes("连续轨迹"));
  assert.ok(!html.includes("手动瞄准"));
});
check("归零卡片保留坐标与光学基准状态，删除常驻教程", () => {
  const checked = structuredClone(ready); checked.turntable!.state = "checked";
  for (const value of Object.values(checked.turntable!.feedback!.axes!)) { value.flags = 3; value.display_mode = 3; }
  const origin = createWorkOrigin(checked, "COM3");
  const control = { port: "COM3", status: checked, disabled: false, request: props.request, onOrigin: () => {}, onStatus: () => {}, onBusy: () => {} };
  const unset = renderToStaticMarkup(<FieldTurntableOriginControl {...control} origin={null} />);
  assert.ok(unset.includes("设置归零"));
  assert.ok(!unset.includes("归零不会校准某个测点"));
  assert.ok(!unset.includes("首个点位：叶片"));
  const relative = renderToStaticMarkup(<FieldTurntableOriginControl {...control} origin={origin} opticalOrigin={origin} />);
  assert.ok(relative.includes("恢复设备坐标")); assert.ok(relative.includes("作业零点已设置"));
  const absolute = renderToStaticMarkup(<FieldTurntableOriginControl {...control} origin={null} opticalOrigin={origin} />);
  assert.ok(absolute.includes("设备坐标 · 光学零点已保留"));
  assert.ok(!absolute.includes("恢复设备坐标仅切换角度显示"));
  assert.ok(absolute.includes('aria-label="作业俯仰角">10.000°'));
});
check("曾设公共零点后参考、服务或串口失效须重设，独立测点校准仍优先", () => {
  const checked = structuredClone(ready); checked.turntable!.state = "checked";
  for (const value of Object.values(checked.turntable!.feedback!.axes!)) { value.flags = 3; value.display_mode = 3; }
  const origin = createWorkOrigin(checked, "COM3");
  assert.equal(autoFollowOpticalOriginError(false, false, null), "", "Legacy flows that never set an origin remain available");
  assert.equal(autoFollowOpticalOriginError(true, false, matchingWorkOrigin(origin, checked, "COM3")), "");
  for (const kind of ["generation", "reference", "port"]) {
    const next = structuredClone(checked);
    if (kind === "generation") next.service.generation!++;
    else if (kind === "reference") next.turntable!.feedback!.axes!["1"].origin_counts++;
    const active = matchingWorkOrigin(origin, next, kind === "port" ? "COM4" : "COM3");
    assert.equal(active, null);
    assert.match(autoFollowOpticalOriginError(true, false, active), /公共光学零点需重新设置/);
    assert.equal(autoFollowOpticalOriginError(true, true, active), "", "An independently valid point anchor may still start");
  }
  const required = renderToStaticMarkup(<FieldAutoFollow {...props} opticalOriginRequired />);

  assert.ok(required.includes("公共光学零点需重新设置：请将激光调至水平并正对叶轮中线"));
  assert.ok(!required.includes("按设备坐标计算 · 先定位再等待"));
  const originUi = renderToStaticMarkup(<FieldTurntableOriginControl port="COM3" status={checked} disabled={false} origin={null} opticalOrigin={null} opticalOriginRequired request={props.request} onOrigin={() => {}} onStatus={() => {}} onBusy={() => {}} />);
  assert.ok(originUi.includes("公共光学零点待重设"));
  assert.ok(originUi.includes("请将激光调至水平并正对叶轮中线，再设置归零"));
});
check("测点半径以转轴中心为基准，已知长度时不能超过叶尖", () => {
  assert.equal(autoFollowPointLengthError(.31, .78), "");
  assert.equal(autoFollowPointLengthError(.78, .78), "");
  assert.equal(autoFollowPointLengthError(.31), "");
  assert.match(autoFollowPointLengthError(.8, .78), /测点超出叶尖/);
});
check("仅恢复草稿字段，丢弃伪造参考和安全确认，保留用户旧周期", () => {
  const restored = readAutoFollowDraft(JSON.stringify({ port: "com3", anchor: { axis1AngleDeg: 1 }, confirmLaser: true, draft: { ...autoFollowDefaults, periodSeconds: 5, signsConfirmed: true, points: [{ id: "p2", name: "叶尖", radiusM: .6, reference: true }] } }));
  assert.equal(restored.draft.activePointId, "p2");
  assert.equal(restored.port, "COM3"); assert.equal(restored.draft.periodSeconds, 5);
  assert.ok(!("anchor" in restored)); assert.ok(!("signsConfirmed" in restored.draft)); assert.ok(!("reference" in restored.draft.points[0]));
  assert.deepEqual(readAutoFollowDraft("corrupted"), readAutoFollowDraft(null));
  const legacy = { ...autoFollowDefaults, points: [{ id: "p2", name: "P2", radiusM: .5 }, ...autoFollowDefaults.points] } as Partial<typeof autoFollowDefaults>; delete legacy.activePointId;
  assert.equal(readAutoFollowDraft(JSON.stringify({ draft: legacy })).draft.activePointId, "p2");
});
check("当前测点或安装变化必须废弃参考，周期和其它测点变化可保留参考", () => {
  const key = autoFollowAnchorKey(autoFollowDefaults, "COM3");
  for (const patch of [{ pitchAngleScale: .9 }, { yawAngleScale: .95 }, { distanceM: 3 }, { hubHeightDeltaM: 2 }, { direction: "counterclockwise" as const }, { axis1Sign: -1 as const }, { axis2Sign: -1 as const }, { activePointId: "p2", points: [{ id: "p2", name: "P2", radiusM: .31 }] }, { points: [{ id: "p1", name: "P1", radiusM: .4 }] }]) assert.notEqual(autoFollowAnchorKey({ ...autoFollowDefaults, ...patch }, "COM3"), key);
  assert.notEqual(autoFollowAnchorKey(autoFollowDefaults, "COM4"), key);
  assert.equal(autoFollowAnchorKey({ ...autoFollowDefaults, periodSeconds: 20, points: [...autoFollowDefaults.points, { id: "p2", name: "P2", radiusM: .5 }] }, "COM3"), key);
  assert.equal(autoFollowAnchorKey({ ...autoFollowDefaults, periodSeconds: 0 }, "COM3"), key, "人手转动不改变已确认测点的光学位置");
});
check("读取锚点必须匹配串口、真实两轴参考、静止和软限位", () => {
  const anchor = autoFollowAnchorFromStatus(ready, "COM3", .31, "p1");
  assert.equal(anchor.axis1AngleDeg, 10); assert.equal(anchor.axis2AngleDeg, 0); assert.ok(anchor.referenceSignature);
  assert.throws(() => autoFollowAnchorFromStatus(ready, "COM4", .31, "p1"));
  for (const patch of [{ fault: 1 }, { motor_rpm: 1 }, { motor_rpm: .01 }, { flags: 16 }, { output_angle_deg: 36 }, { output_angle_deg: null }, { guard: { soft_enabled: false, hardware_enabled: false, minimum_deg: -35, maximum_deg: 35 } }, { guard: { soft_enabled: true, hardware_enabled: false, minimum_deg: -36, maximum_deg: 35 } }]) {
    const next = structuredClone(ready); Object.assign(next.turntable!.feedback!.axes!["1"], patch);
    assert.throws(() => autoFollowAnchorFromStatus(next, "COM3", .31, "p1"));
  }
});
check("计划需有效参考、全部目标在当前软限位内且设备就绪", () => {
  const anchor = autoFollowAnchorFromStatus(ready, "COM3", .31, "p1"), plan = planAutoFollow(autoFollowDefaults, anchor);
  assert.deepEqual(autoFollowBlockers(config, ready, plan, anchor, "COM3"), []);
  const noHorizontalGuard = structuredClone(ready); noHorizontalGuard.turntable!.feedback!.axes!["2"].guard.soft_enabled = false;
  assert.deepEqual(autoFollowBlockers(config, noHorizontalGuard, plan, anchor, "COM3"), []);
  assert.deepEqual(autoFollowAnchorFromStatus(noHorizontalGuard, "COM3", .31, "p1"), anchor);
  const narrow = structuredClone(ready); narrow.turntable!.feedback!.axes!["2"].guard.minimum_deg = -1;
  assert.ok(autoFollowBlockers(config, narrow, plan, anchor, "COM3").some(x => x.includes("超出当前软限位")));
  assert.ok(autoFollowBlockers(config, { ...ready, service: { state: "ready", dllConfigured: false } }, plan, anchor, "COM3").length > 0);
});
check("水平轴关闭软限位不放宽参考、静止、故障和启用后的实际范围", () => {
  const horizontal = structuredClone(ready); horizontal.turntable!.feedback!.axes!["2"].guard.soft_enabled = false;
  const anchor = autoFollowAnchorFromStatus(horizontal, "COM3", .31, "p1"), plan = planAutoFollow(autoFollowDefaults, anchor);
  for (const patch of [{ fault: 2 }, { motor_rpm: .01 }, { flags: 16 }, { output_angle_deg: null }, { output_angle_deg: 181 }]) {
    const next = structuredClone(horizontal); Object.assign(next.turntable!.feedback!.axes!["2"], patch);
    assert.throws(() => autoFollowAnchorFromStatus(next, "COM3", .31, "p1"));
    assert.ok(autoFollowBlockers(config, next, plan, anchor, "COM3").length > 0);
  }
  const changed = structuredClone(horizontal); changed.turntable!.feedback!.axes!["2"].origin_counts++;
  assert.ok(autoFollowBlockers(config, changed, plan, anchor, "COM3").some(value => value.includes("参考位")));
  for (const [minimum_deg, maximum_deg] of [[NaN, 180], [-180, Infinity], [1, -1], [0, 0], [1, 5]]) {
    const next = structuredClone(ready); Object.assign(next.turntable!.feedback!.axes!["2"].guard, { minimum_deg, maximum_deg });
    assert.throws(() => autoFollowAnchorFromStatus(next, "COM3", .31, "p1"));
    assert.ok(autoFollowBlockers(config, next, plan, anchor, "COM3").some(value => value.includes("软限位")));
  }
});
check("采集中锁定路线配置，点位页不再提供采集起停入口", () => {
  const status: FieldStatus = { ...ready, state: "acquiring", pointCycle: { state: "capturing", port: "COM3", cycles: 1, dwellSeconds: 60, speedRpm: .6, pointCount: 4, cycle: 1, point: 1, completedRecords: 0, totalRecords: 4 } };
  const html = renderToStaticMarkup(<FieldTurntableWorkspace {...props} status={status} disabled />);
  assert.match(html, /role="tab"[^>]*disabled=""/);
  assert.ok(!html.includes("开始自动采集")); assert.ok(!/>停止并保存<\/button>/.test(html));
  assert.ok(!html.includes("field-capture-chart"));
});
check("测量设置先于测点配置，转盘参数集中在设置弹窗", () => {
  const html = renderToStaticMarkup(<FieldAutoFollow {...props} />);
  assert.ok(html.includes('role="radiogroup"')); assert.ok(html.includes('aria-label="选择测点1"'));
  assert.ok(html.includes("本次采集测点")); assert.ok(html.includes("添加测点"));
  assert.ok(html.includes("叶片与测点")); assert.ok(html.includes("添加叶片"));
  assert.ok(html.indexOf("测量设置") < html.indexOf("叶片与测点"));
  assert.ok(html.includes('aria-label="叶根预留 · %"')); assert.ok(html.includes('aria-label="叶尖预留 · %"'));
  assert.ok(!html.includes("叶根位置")); assert.ok(!html.includes("叶根距风机旋转中心"));
  assert.ok(html.includes("风机转轴中心到叶尖的距离"));
  assert.ok(html.includes('aria-label="叶片长度 · m"')); assert.ok(html.includes("生成5个测点"));
  assert.ok(html.includes('aria-label="激光出射点离地高度 · m"'));
  assert.ok(html.includes('aria-label="风机旋转中心离地高度 · m"'));
  assert.ok(html.includes('<output aria-label="风机旋转中心与激光高差">'));
  assert.ok(!html.includes('aria-label="风机旋转中心高于激光器 · m"'));
  assert.ok(html.includes('aria-label="配置叶片"')); assert.ok(html.includes('aria-label="目标叶片编号"'));
  assert.ok(!html.includes("两轴换点转速上限 · rpm"));
  assert.match(html, /class="field-card field-turntable-settings-card"/);
});
check("双轴能力须经当前串口探测确认，释放串口不抹去已确认能力", () => {
  const next = structuredClone(ready);
  next.turntable!.connected = false;
  next.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", protocol: "0x30-0x36", probe: "confirmed", status: {} };
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM3"), "dual_axis_timed");
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM4"), "unknown");
  assert.equal(fieldTurntableMotionMode(ready.turntable, "COM3"), "unknown");
  const html = renderToStaticMarkup(<FieldTurntableManual status={next} disabled={false} request={props.request} />);
  assert.ok(html.includes("已识别双轴联动")); assert.ok(html.includes("两轴同时启动并按同一时长到位"));
  assert.ok(!html.includes("两轴角度差绝对值之和"));
  next.turntable!.motionCapability = { supported: false, mode: "sequential", protocol: null, probe: "driver-unavailable", status: null };
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM3"), "unknown");
  next.turntable!.motionCapability.probe = "legacy-command-unsupported";
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM3"), "sequential");
  const unknown = renderToStaticMarkup(<FieldAutoFollow {...props} />);
  assert.ok(!unknown.includes("已识别双轴联动"));
});
check("内部定位显示实际模式，速度沿用上限且不把轨迹加速度冒充驱动参数", () => {
  const next = structuredClone(ready);
  next.turntable!.motionCapability = { supported: true, mode: "dual_axis_timed", pointMode: "drive_internal", protocol: "0x30-0x36", probe: "confirmed", status: {} };
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM3"), "drive_internal");
  assert.equal(fieldTurntableMotionMode(next.turntable, "COM4"), "unknown");
  const html = renderToStaticMarkup(<FieldTurntableManual status={next} disabled={false} request={props.request} />);
  assert.ok(html.includes("控制器反馈定位"));
  assert.ok(html.includes("运动可重叠"));
  assert.ok(!html.includes("两轴同时启动并按同一时长到位"));
  const auto = renderToStaticMarkup(<FieldAutoFollow {...props} status={next} connectionPort="COM3" />);
  assert.doesNotMatch(auto, /aria-label="运动中行程误差上限 · °"/);
  assert.ok(!auto.includes('aria-label="换点加速度上限 · °/s²"'));
  assert.doesNotMatch(auto, /当前测点路线/);
});
check("双轴回位提供整次停止，运动反馈使用实际执行方式", () => {
  const next = structuredClone(ready);
  next.turntableBusy = true;
  next.turntable!.motionMode = "dual_axis_timed";
  next.turntable!.recall = { state: "moving", targets: [10.1, .1], completedAxes: [] };
  next.turntable!.lastMove = { mode: "dual_axis_timed", plannedSeconds: 1.05, measurementDuringMotion: false };
  const html = renderToStaticMarkup(<FieldTurntableManual status={next} disabled={false} request={props.request} />);
  assert.ok(html.includes("两轴同步定位")); assert.ok(html.includes("运动计划 1.05 s"));
  const stop = html.match(/<button\b[^>]*>.*?<\/button>/gs)?.find(button => button.includes("停止两轴回位"));
  assert.ok(stop && !stop.includes("disabled"));
});
check("同风机任务跨叶片与测点复用采集编号，改变任务归属新建，拒绝损坏编号", () => {
  const context = autoFollowCollectionContext(config, "2"), id = "1".repeat(32);
  const first = autoFollowCollection({ collectionId: "", collectionContext: "" }, context, () => id);
  assert.equal(first.collectionId, id);
  assert.strictEqual(autoFollowCollection(first, autoFollowCollectionContext({ ...config, name: ` ${config.name} ` }, "2"), () => { throw Error("No new ID"); }), first);
  assert.equal(autoFollowCollectionContext({ ...config, windFarm: "  " }), context, "Legacy empty farm preserves task identity");
  assert.notEqual(autoFollowCollectionContext({ ...config, windFarm: "WF-001" }), context);
  assert.equal(autoFollowCollectionContext({ ...config, windFarm: " WF-001 " }), autoFollowCollectionContext({ ...config, windFarm: "WF-001" }));
  assert.notEqual(autoFollowCollectionContext({ ...config, windFarm: "WF-001" }), autoFollowCollectionContext({ ...config, windFarm: "WF-002" }));
  assert.equal(autoFollowCollectionContext(config, "3"), context, "Changing the selected blade keeps the same wind-turbine task");
  assert.equal(autoFollowCollectionContext({ ...config, point: "P2", hostIp: "198.51.100.22" }, "3"), context,
    "Point selection and local interface changes do not split the task");
  assert.equal(autoFollowCollectionContext({ ...config, turbine: config.name }), context, "An omitted turbine derives from the task name");
  assert.equal(autoFollowCollectionContext({ ...config, turbine: "   " }), context, "Whitespace turbine names count as omitted");
  assert.strictEqual(autoFollowCollection(first, autoFollowCollectionContext(config, "3"), () => { throw Error("No new ID"); }), first);
  for (const next of [autoFollowCollectionContext({ ...config, name: "新任务" }, "2"), autoFollowCollectionContext({ ...config, object: "新对象" }, "2"), autoFollowCollectionContext({ ...config, turbine: "新机组" }, "2"), autoFollowCollectionContext({ ...config, deviceIp: "198.51.100.20" }, "2")]) {
    assert.equal(autoFollowCollection(first, next, () => "2".repeat(32)).collectionId, "2".repeat(32));
  }
  assert.equal(autoFollowCollection({ ...first, collectionId: id + "\n" }, context, () => "3".repeat(32)).collectionId, "3".repeat(32));
  const stored = readAutoFollowDraft(JSON.stringify({ draft: autoFollowDefaults, ...first }));
  assert.equal(stored.collectionId, id); assert.equal(stored.collectionContext, context);
  assert.equal(readAutoFollowDraft(JSON.stringify({ draft: autoFollowDefaults, ...first, collectionId: id + "\n" })).collectionId, "");
});
check("风机任务身份统一去除外部空白和Unicode组合差异，现场任务名称仍独立", () => {
  const named = { ...config, name: "é", object: "叶片", turbine: "风机一" };
  assert.equal(autoFollowCollectionContext(named), autoFollowCollectionContext({ ...named, name: " e\u0301 ", object: " 叶片 ", turbine: " 风机一 ", deviceIp: ` ${named.deviceIp} ` }));
  assert.notEqual(autoFollowCollectionContext(named), autoFollowCollectionContext({ ...named, name: "另一次检测" }));
  const legacyContext = JSON.stringify([config.name, config.object, config.turbine, config.deviceIp, "2"]);
  const changed = autoFollowCollection({ collectionId: "1".repeat(32), collectionContext: legacyContext }, autoFollowCollectionContext(config), () => "2".repeat(32));
  assert.equal(changed.collectionId, "2".repeat(32), "Legacy context is not guessed into the new wind-turbine identity");
});
console.log(`PASS ${checks} automatic-follow UI checks; hardware not used`);
