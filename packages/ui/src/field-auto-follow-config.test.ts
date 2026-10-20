// Configuration migration and identity tests only. No bridge or hardware access.
import assert from "node:assert/strict";
import { autoFollowDefaults, planAutoFollow } from "./field-auto-follow-plan";
import { autoFollowHeightDelta, autoFollowTargetKey, defaultAutoFollowSurvey, generateAutoFollowBladePoints, readAutoFollowSurvey, selectSurveyTarget,
  surveyDraft, surveyIdentityErrors, type AutoFollowSurvey } from "./field-auto-follow-config";

let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }
const read = (saved: unknown) => readAutoFollowSurvey(JSON.stringify(saved));
const point = (id = "p1", name = "P1", radiusM = .31) => ({ id, name, radiusM });
const blade = (id = "blade-a", name = "A", points = [point()]) => ({ id, name, points });
const v3 = (): AutoFollowSurvey => ({ ...defaultAutoFollowSurvey(), blades: [blade("a", "A"), blade("b", "B", [point("p2", "P2", .5)])],
  selectedBladeId: "b", selectedPointId: "p2" });

check("各版本旧配置保留0.75度默认，跟随误差新设置持久化，非法值不会悄悄变成默认", () => {
  for (const version of [1, 2, 3]) {
    const values = { ...autoFollowDefaults } as Record<string, unknown>;
    delete values.followErrorLimitDeg;
    const old = version === 1 ? { draft: values } : { ...v3(), version, settings: values };
    const restored = read(old);
    assert.equal(surveyDraft(restored).followErrorLimitDeg, .75);
    restored.settings.followErrorLimitDeg = 1.5;
    const reloaded = read(restored);
    assert.equal(surveyDraft(reloaded).followErrorLimitDeg, 1.5);
    assert.deepEqual(reloaded.blades, restored.blades);
    assert.equal(reloaded.selectedPointId, restored.selectedPointId);
    for (const invalid of [0, .49, 10.01, null, "1.5", true]) {
      const broken = read({ ...restored, settings: { ...restored.settings, followErrorLimitDeg: invalid } });
      const plan = planAutoFollow(surveyDraft(broken), null, "dual_axis_timed", "COM3");
      assert.ok(plan.errors.some(error => error.includes("跟随误差上限")));
      assert.equal(plan.pointCycle, undefined);
    }
  }
});

check("旧配置沿用3度加速度，新设置持久保存且不改动测点", () => {
  for (const version of [1, 2]) {
    const values = { ...autoFollowDefaults } as Record<string, unknown>;
    delete values.maxMoveAccelerationDegS2;
    const saved = version === 1 ? { draft: values } : { ...v3(), settings: values };
    const restored = read(saved);
    assert.equal(surveyDraft(restored).maxMoveAccelerationDegS2, 3);
    restored.settings.maxMoveAccelerationDegS2 = 30;
    const reloaded = read(restored);
    assert.equal(surveyDraft(reloaded).maxMoveAccelerationDegS2, 30);
    assert.deepEqual(reloaded.blades, restored.blades);
  }
});

check("无保存配置和坏JSON使用独立默认配置，不能共享可变测点", () => {
  for (const raw of [null, "", "{", "null", "[]", "true"]) {
    const survey = readAutoFollowSurvey(raw);
    assert.equal(survey.version, 3); assert.equal(survey.blades.length, 1);
    assert.equal(surveyDraft(survey).periodSeconds, autoFollowDefaults.periodSeconds);
  }
  const one = defaultAutoFollowSurvey(), two = defaultAutoFollowSurvey();
  one.settings.periodSeconds = 100; one.blades[0].points[0].radiusM = 99;
  assert.equal(two.settings.periodSeconds, 30); assert.equal(two.blades[0].points[0].radiusM, .31);
});

check("v1单叶片及多个测点完整迁移，保留当前测点、空半径与任务身份", () => {
  const collectionId = "a".repeat(32);
  const survey = read({ draft: { ...autoFollowDefaults, bladeId: "叶片2", periodSeconds: 45,
    points: [point(), { id: "p2", name: "叶尖", radiusM: null }], activePointId: "p2" },
    port: " com3 ", collectionId, collectionContext: "existing-task-context" });
  assert.equal(survey.version, 3); assert.equal(survey.blades.length, 1); assert.equal(survey.blades[0].name, "叶片2");
  assert.deepEqual(survey.blades[0].points[0], point());
  assert.equal(survey.blades[0].points[1].name, "叶尖"); assert.ok(Number.isNaN(survey.blades[0].points[1].radiusM));
  assert.equal(survey.selectedPointId, "p2"); assert.equal(surveyDraft(survey).periodSeconds, 45);
  assert.equal(survey.port, "COM3"); assert.equal(survey.collectionId, collectionId); assert.equal(survey.collectionContext, "existing-task-context");
  assert.ok(planAutoFollow(surveyDraft(survey), null).errors.some(error => error.includes("有效半径")));
});

check("每圈时间0按人手转动保留，切回定速不丢原等待圈数或任务身份", () => {
  for (const version of [1, 2]) {
    const saved = version === 1 ? { port: "COM3", draft: { ...autoFollowDefaults, periodSeconds: 0, waitRevolutions: 4 } }
      : { ...v3(), port: "COM3", settings: { ...v3().settings, periodSeconds: 0, waitRevolutions: 4 } };
    const manual = read(saved), restored = read(manual);
    assert.equal(surveyDraft(restored).periodSeconds, 0);
    assert.equal(restored.settings.waitRevolutions, 4);
    assert.ok(planAutoFollow(surveyDraft(restored), null, "sequential", restored.port).pointCycle);
    const timed = { ...restored, settings: { ...restored.settings, periodSeconds: 30 } };
    assert.equal(planAutoFollow(surveyDraft(timed), null, "sequential", timed.port).pointCycle!.dwellSeconds, 120);
    assert.deepEqual(timed.blades, restored.blades); assert.equal(timed.collectionId, restored.collectionId);
  }
});

check("保存的标定、运动状态和未知字段均不恢复到survey或draft", () => {
  const anchor = { axis1AngleDeg: 25, axis2AngleDeg: 0, port: "COM3", pointId: "p1", radiusM: .31,
    referenceSignature: "old-reference" };
  for (const saved of [
    { draft: { ...autoFollowDefaults, anchor, running: true, confirmMotion: true }, anchor, enabled: true, running: true },
    { ...v3(), anchor, enabled: true, settings: { ...v3().settings, anchor, referenceSignature: "old", running: true },
      blades: [{ ...blade(), anchor, points: [{ ...point(), anchor, referenceSignature: "old" }] }] },
  ]) {
    const survey = read(saved), draft = surveyDraft(survey);
    assert.ok(!("anchor" in survey)); assert.ok(!("enabled" in survey)); assert.ok(!("running" in survey));
    assert.ok(!("anchor" in survey.settings)); assert.ok(!("referenceSignature" in survey.settings));
    assert.ok(!("anchor" in survey.blades[0])); assert.ok(!("referenceSignature" in survey.blades[0].points[0]));
    assert.ok(!("anchor" in draft)); assert.ok(!("confirmMotion" in draft));
    assert.equal(planAutoFollow(draft, null).origin, "theoretical");
    assert.ok(!planAutoFollow(draft, null).errors.some(error => error.includes("校准")));
  }
});

check("v3保留选中的叶片测点，选择不存在或越过上限的项目时安全回落", () => {
  const survey = read(v3());
  assert.equal(survey.selectedBladeId, "b"); assert.equal(survey.selectedPointId, "p2");
  assert.equal(surveyDraft(survey).bladeId, "B"); assert.equal(surveyDraft(survey).activePointId, "p2");
  assert.deepEqual(surveyDraft(survey, "a", "p1").points, [point()]);
  const missingBlade = read({ ...v3(), selectedBladeId: "missing", selectedPointId: "missing" });
  assert.equal(missingBlade.selectedBladeId, "a"); assert.equal(missingBlade.selectedPointId, "p1");
  const many = Array.from({ length: 15 }, (_, index) => blade(`b${index}`, String(index),
    Array.from({ length: 45 }, (_, pointIndex) => point(`p${pointIndex}`, `P${pointIndex}`, (pointIndex + 1) / 100))));
  const limited = read({ ...v3(), blades: many, selectedBladeId: "b14", selectedPointId: "p44" });
  assert.equal(limited.blades.length, 12); assert.ok(limited.blades.every(item => item.points.length === 40));
  assert.equal(limited.selectedBladeId, "b0"); assert.equal(limited.selectedPointId, "p0");
  const empty = read({ ...v3(), blades: [] });
  assert.equal(empty.blades.length, 0); assert.equal(empty.selectedBladeId, ""); assert.equal(empty.selectedPointId, "");
  assert.ok(surveyIdentityErrors(empty).length);
});

check("任务ID需要完整有效身份，Mac串口大小写与输入空半径保持原义", () => {
  for (const collectionId of ["not-an-id", "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(32) + "\n", null]) {
    const survey = read({ ...v3(), collectionId, collectionContext: "context" });
    assert.equal(survey.collectionId, ""); assert.equal(survey.collectionContext, "");
  }
  assert.equal(read({ ...v3(), collectionId: "a".repeat(32), collectionContext: null }).collectionId, "");
  const survey = read({ ...v3(), port: " /dev/cu.usbserial-Aa12 ",
    blades: [blade("a", "A", [{ id: "empty", name: "", radiusM: NaN }])], selectedBladeId: "a", selectedPointId: "empty" });
  assert.equal(survey.port, "/dev/cu.usbserial-Aa12"); assert.equal(survey.blades[0].points[0].name, "");
  assert.ok(Number.isNaN(survey.blades[0].points[0].radiusM));
});

check("不同叶片可有同名同标识测点，复合选择键不会混淆或改动原配置", () => {
  const survey = { ...v3(), blades: [blade("a", "A"), blade("b", "B")] };
  assert.deepEqual(surveyIdentityErrors(survey), []);
  const selected = selectSurveyTarget(survey, autoFollowTargetKey("a", "p1"));
  assert.equal(selected.selectedBladeId, "a"); assert.equal(selected.selectedPointId, "p1");
  assert.equal(survey.selectedBladeId, "b");
  const next = selectSurveyTarget(selected, autoFollowTargetKey("b", "p1"));
  assert.equal(next.selectedBladeId, "b"); assert.equal(surveyDraft(next).bladeId, "B");
  assert.equal(selectSurveyTarget(survey, "not-a-target"), survey);
  assert.notEqual(autoFollowTargetKey("a/b", "c"), autoFollowTargetKey("a", "b/c"));
});

check("重复叶片编号、重复叶片标识、同叶片点名和点标识都被阻止", () => {
  for (const names of [["A", " A "], ["é", "e\u0301"]]) {
    assert.ok(surveyIdentityErrors({ ...v3(), blades: [blade("a", names[0]), blade("b", names[1])] })
      .some(error => error.includes("叶片编号不能重复")));
  }
  assert.ok(surveyIdentityErrors({ ...v3(), blades: [blade("a", "A"), blade("a", "B")] }).some(error => error.includes("叶片标识重复")));
  for (const points of [[point(), point("p2", " P1 ")], [point("p1", "é"), point("p2", "e\u0301")]]) {
    assert.ok(surveyIdentityErrors({ ...v3(), blades: [blade("a", "A", points)] }).some(error => error.includes("测点名称不能重复")));
  }
  assert.ok(surveyIdentityErrors({ ...v3(), blades: [blade("a", "A", [point(), point("p1", "P2")])] })
    .some(error => error.includes("测点标识重复")));
  assert.ok(surveyIdentityErrors({ ...v3(), blades: [blade("a", " ")] }).some(error => error.includes("有效的叶片编号")));
});

check("无效数字设置保留无效状态，不能悄悄恢复可运行的默认值", () => {
  for (const version of [1, 2]) for (const [field, value, message] of [
    ["periodSeconds", "30", "每圈时间"], ["periodSeconds", -1, "每圈时间"], ["stepDeg", null, "圆周间隔"],
    ["cycles", "2", "重复采样圈数"], ["distanceM", {}, "安装距离"], ["maxMoveRpm", null, "换点速度"],
    ["maxMoveAccelerationDegS2", null, "换点加速度"], ["maxMoveAccelerationDegS2", "30", "换点加速度"],
    ["axis1Sign", "1", "旋向和转盘轴方向"],
  ] as const) {
    const saved = version === 1 ? { draft: { ...autoFollowDefaults, [field]: value } }
      : { ...v3(), settings: { ...v3().settings, [field]: value } };
    const survey = read(saved);
    assert.ok(planAutoFollow(surveyDraft(survey), null).errors.some(error => error.includes(message)), `v${version} ${field}=${JSON.stringify(value)}`);
  }
  for (const radiusM of [null, "", "0.31", {}, 0]) {
    const survey = read({ draft: { ...autoFollowDefaults, points: [{ id: "p1", name: "P1", radiusM }] } });
    assert.ok(planAutoFollow(surveyDraft(survey), null).errors.some(error => error.includes("有效半径")));
  }
});

check("无效旋向不能被默认顺时针覆盖", () => {
  for (const version of [1, 2]) for (const direction of ["invalid", "", null, 123, false, {}]) {
    const saved = version === 1 ? { draft: { ...autoFollowDefaults, direction } }
      : { ...v3(), settings: { ...v3().settings, direction } };
    assert.ok(planAutoFollow(surveyDraft(read(saved)), null).errors.some(error => error.includes("旋向和转盘轴方向")),
      `v${version} direction=${JSON.stringify(direction)} must remain invalid`);
  }
});

check("中心至叶尖长度按两端预留等分生成五点，默认仍为10/30/50/70/90%", () => {
  let sequence = 0;
  const points = generateAutoFollowBladePoints(.78, 10, 10, () => `new-${++sequence}`);
  assert.deepEqual(points.map(item => item.name), ["P1", "P2", "P3", "P4", "P5"]);
  assert.deepEqual(points.map(item => item.radiusM), [.078, .234, .39, .546, .702]);
  const custom = generateAutoFollowBladePoints(1, 5, 20, () => `new-${++sequence}`);
  assert.deepEqual(custom.map(item => item.radiusM), [.05, .2375, .425, .6125, .8]);
  assert.equal(new Set([...points, ...custom].map(item => item.id)).size, 10);
});

check("可用区间不做固定比例或偏移，保留精度并拒绝重合、越界和无效比例", () => {
  let sequence = 0;
  assert.equal(generateAutoFollowBladePoints(1, 15, 5, () => `tidy-${++sequence}`)[0].radiusM, .15);
  assert.equal(generateAutoFollowBladePoints(.01)[0].radiusM, .001);
  assert.equal(generateAutoFollowBladePoints(1000, 10, 0)[4].radiusM, 1000);
  for (const value of [0, -1, NaN, Infinity, -Infinity, "1", null, 1000.01])
    assert.throws(() => generateAutoFollowBladePoints(value as number), /有效叶片长度/);
  for (const value of [-1, 100, NaN, Infinity, "10", null]) {
    assert.throws(() => generateAutoFollowBladePoints(1, value as number, 10), /预留比例/);
    assert.throws(() => generateAutoFollowBladePoints(1, 10, value as number), /预留比例/);
  }
  assert.throws(() => generateAutoFollowBladePoints(1, 50, 50), /之和必须小于100/);
  assert.throws(() => generateAutoFollowBladePoints(1, 70, 40), /之和必须小于100/);
  assert.throws(() => generateAutoFollowBladePoints(.009), /0.001～1000米/);
  assert.throws(() => generateAutoFollowBladePoints(1, 0, 10), /0.001～1000米/);
  assert.throws(() => generateAutoFollowBladePoints(1, 10, 89.99999999999999), /无法区分五个测点/);
  assert.throws(() => generateAutoFollowBladePoints(1, 10, 10, () => "reused"), /编号生成失败/);
  assert.throws(() => generateAutoFollowBladePoints(1, 10, 10, () => ""), /编号生成失败/);
});

check("每片叶片独立保存预留比例和手改点位，重载不自动生成或改动其他叶片", () => {
  const original = { ...v3(), blades: [
    { ...blade("a", "A", [point("manual", "手改测点", .415)]), lengthM: 1, rootReservePercent: 5, tipReservePercent: 20, anchor: "ignored" },
    { ...blade("b", "B", [point("old", "既有点", .9)]), lengthM: 2, rootReservePercent: 12.5, tipReservePercent: 15 },
  ] };
  const loaded = read(original);
  assert.deepEqual(loaded.blades.map(item => [item.lengthM, item.rootReservePercent, item.tipReservePercent]), [[1, 5, 20], [2, 12.5, 15]]);
  assert.deepEqual(loaded.blades.map(item => item.points), original.blades.map(item => item.points));
  assert.ok(!("anchor" in loaded.blades[0]));
  let sequence = 0;
  const generatedA = generateAutoFollowBladePoints(1, 5, 20, () => `regen-${++sequence}`);
  const replaced = { ...loaded, blades: loaded.blades.map(item => item.id === "a" ? { ...item, points: generatedA } : item) };
  assert.equal(replaced.blades[0].points.length, 5); assert.deepEqual(replaced.blades[1], loaded.blades[1]);
  assert.equal(loaded.blades[0].points[0].id, "manual");
  assert.deepEqual(read(replaced), replaced);
});

check("旧长度加叶根偏移仅迁移一次，不移动旧测点或保留新配置中的偏移字段", () => {
  const old = { ...v3(), version: 2, blades: [{ ...blade(), lengthM: 1, rootRadiusM: .2 }] };
  const loaded = read(old);
  assert.equal(loaded.version, 3); assert.equal(loaded.blades[0].lengthM, 1.2);
  assert.ok(!("rootRadiusM" in loaded.blades[0]));
  assert.deepEqual(loaded.blades[0].points, old.blades[0].points);
  assert.equal(read(loaded).blades[0].lengthM, 1.2);
  const legacy = read({ draft: { ...autoFollowDefaults, lengthM: 1.5, rootRadiusM: .1 } });
  assert.equal(legacy.blades[0].lengthM, 1.6);
  assert.deepEqual(legacy.blades[0].points, autoFollowDefaults.points);
  assert.equal(read({ ...old, blades: [{ ...blade(), lengthM: .78, rootRadiusM: 0 }] }).blades[0].lengthM, .78);
});

check("旧配置没有尺寸时保持未知，空值与坏比例不恢复成可生成的默认设置", () => {
  for (const saved of [{ draft: autoFollowDefaults }, v3()]) {
    const loaded = read(saved);
    assert.ok(loaded.blades.every(item => item.lengthM === undefined && !("rootRadiusM" in item)));
    assert.ok(loaded.blades.every(item => item.points.length === 1));
  }
  for (const lengthM of [null, "", "1", {}, 0, -1]) {
    const loaded = read({ ...v3(), blades: [{ ...blade(), lengthM }] });
    assert.ok(Number.isNaN(loaded.blades[0].lengthM));
    assert.deepEqual(loaded.blades[0].points, [point()]);
  }
  for (const percent of [null, "", "10", {}, -1, 100, Infinity]) {
    const loaded = read({ ...v3(), blades: [{ ...blade(), lengthM: 1, rootReservePercent: percent, tipReservePercent: percent }] });
    assert.ok(Number.isNaN(loaded.blades[0].rootReservePercent)); assert.ok(Number.isNaN(loaded.blades[0].tipReservePercent));
    assert.ok(Number.isNaN(read(loaded).blades[0].rootReservePercent));
  }
});

check("风机旋转中心与激光器实测离地高度自动相减，任一高度改变均更新高差", () => {
  assert.equal(autoFollowHeightDelta({ hubHeightM: 1.5, laserHeightM: .65 }), .85);
  assert.equal(autoFollowHeightDelta({ hubHeightM: 1.6, laserHeightM: .65 }), .95);
  assert.equal(autoFollowHeightDelta({ hubHeightM: 1.5, laserHeightM: .75 }), .75);
  assert.equal(autoFollowHeightDelta({ hubHeightM: .65, laserHeightM: 1.5 }), -.85);
  assert.equal(autoFollowHeightDelta({ hubHeightM: 0, laserHeightM: 0 }), 0);
  assert.equal(autoFollowHeightDelta({ hubHeightM: 10000, laserHeightM: 0 }), 10000);
  assert.equal(autoFollowHeightDelta({ hubHeightM: 0, laserHeightM: 10000 }), -10000);
  const survey = { ...v3(), heights: { hubHeightM: 1.5, laserHeightM: .65 } };
  assert.equal(surveyDraft(survey).hubHeightDeltaM, .85);
  assert.equal(surveyDraft({ ...survey, heights: { ...survey.heights, laserHeightM: .75 } }).hubHeightDeltaM, .75);
});

check("未提供离地高度的旧配置保持原高差，不猜物理高度且不覆盖既有点位", () => {
  assert.equal(defaultAutoFollowSurvey().heights, undefined);
  assert.equal(autoFollowDefaults.hubHeightDeltaM, 1.46);
  for (const saved of [
    { draft: { ...autoFollowDefaults, hubHeightDeltaM: -.2 } },
    { ...v3(), settings: { ...v3().settings, hubHeightDeltaM: .4 } },
  ]) {
    const loaded = read(saved);
    assert.equal(loaded.heights, undefined);
    assert.equal(surveyDraft(loaded).hubHeightDeltaM, "draft" in saved ? -.2 : .4);
    const reloaded = read(loaded);
    assert.equal(reloaded.heights, undefined); assert.equal(surveyDraft(reloaded).hubHeightDeltaM, surveyDraft(loaded).hubHeightDeltaM);
    assert.deepEqual(reloaded.blades, loaded.blades);
  }
});

check("新离地高度优先于旧高差，v1与v3反复读写保留相同投影及白名单", () => {
  for (const saved of [
    { draft: { ...autoFollowDefaults, hubHeightDeltaM: 99 }, heights: { hubHeightM: 1.5, laserHeightM: .65, anchor: "ignored" } },
    { ...v3(), settings: { ...v3().settings, hubHeightDeltaM: 99 }, heights: { hubHeightM: 1.5, laserHeightM: .65, anchor: "ignored" } },
  ]) {
    let loaded = read(saved);
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(loaded.heights, { hubHeightM: 1.5, laserHeightM: .65 });
      assert.equal(loaded.settings.hubHeightDeltaM, 99, "Legacy protocol field is retained while the projected draft uses measured heights");
      assert.equal(surveyDraft(loaded).hubHeightDeltaM, .85);
      const next = read(loaded); assert.deepEqual(next.blades, loaded.blades); loaded = next;
    }
  }
});

check("缺失或非法离地高度不能复活旧高差，空值反复读写仍未知", () => {
  const invalidValues = [null, "", "1.5", -1, 10000.0001, {}, [], true, NaN, Infinity, -Infinity];
  for (const key of ["hubHeightM", "laserHeightM"] as const) for (const value of invalidValues) {
    const heights = { hubHeightM: 1.5, laserHeightM: .65, [key]: value };
    const loaded = read({ ...v3(), settings: { ...v3().settings, hubHeightDeltaM: .9 }, heights });
    assert.ok(Number.isNaN(loaded.heights![key]));
    assert.ok(Number.isNaN(surveyDraft(loaded).hubHeightDeltaM), `${key}=${JSON.stringify(value)} must not fall back to legacy height`);
    assert.ok(Number.isNaN(surveyDraft(read(loaded)).hubHeightDeltaM));
    assert.ok(planAutoFollow(surveyDraft(loaded), null).errors.some(error => error.includes("安装距离和高度差")));
  }
  for (const heights of [{}, { hubHeightM: 1.5 }, { laserHeightM: .65 }, null, "", []]) {
    const loaded = read({ draft: { ...autoFollowDefaults, hubHeightDeltaM: .9 }, heights });
    assert.ok(loaded.heights !== undefined); assert.ok(Number.isNaN(surveyDraft(loaded).hubHeightDeltaM));
  }
  assert.ok(Number.isNaN(autoFollowHeightDelta({ hubHeightM: NaN, laserHeightM: 0 })));
  assert.ok(Number.isNaN(autoFollowHeightDelta({ hubHeightM: 1, laserHeightM: -1 })));
});

console.log(`PASS ${checks} auto-follow configuration checks; no hardware used`);
