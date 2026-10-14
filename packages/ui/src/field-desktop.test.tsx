// Static rendering and pure presentation-contract checks. Not a device or browser test.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldLoginPanel, FieldPasswordPanel, FieldRecordingList, FieldServicePanel, FieldStartDialog, FieldWaveChart } from "./field-desktop";
import { fieldCanStart, fieldDate, fieldIsActive, fieldSampleX, validateFieldConfig, type FieldAccountInfo, type FieldRequestOptions, type FieldStatus, type FieldWaveform } from "./field-types";
import { FieldAccountPanel, FieldCloudSyncPanel, FieldBindAccountDialog, fieldAccountServerDefault, fieldAccountTime, fieldAccountUsesPlainHttp } from "./field-account";
import { clampWaveRange, formatWaveTime, waveBounds, waveScaleDraft, type WaveScaleDraft } from "./field-waveform";
import { FieldDeviceSnapshot } from "./field-device";

let checks = 0;
function check(name: string, run: () => void) { run(); checks += 1; console.log("PASS " + name); }
const waveform: FieldWaveform = { sampleRate: 2000, sampleStart: 100, sampleStride: 5, unit: "m/s", values: [0.001, -0.001, 0.002], rssi: [40, null, 60], rssiUnit: "%", overrange: [false, true, false] };
const ready: FieldStatus = { service: { state: "ready", dllConfigured: true }, state: "idle" };
check("抽样步长参与时间轴，不能把抽样预览误当连续样本", () => {
  assert.equal(fieldSampleX(waveform, 0), 50);
  assert.equal(fieldSampleX(waveform, 2), 55);
});
check("未知采样率只能显示样本序号", () => {
  assert.equal(fieldSampleX({ ...waveform, sampleRate: null }, 2), 110);
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, sampleRate: null }} />);
  assert.ok(html.includes("样本序号"));
  assert.ok(!html.includes("时间 / ms"));
});
check("空波形等待显式设备或模拟输入，不自行绘制数据", () => {
  const html = renderToStaticMarkup(<FieldWaveChart />);
  assert.ok(html.includes("等待振动数据"));
  assert.ok(html.includes("开始设备采集或模拟采集后显示输入波形"));
  assert.ok(!html.includes('class="field-wave-svg"'));
});
check("真实速度曲线标注单位和时间轴", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={waveform} />);
  assert.ok(html.includes("m/s"));
  assert.ok(html.includes("时间 / ms"));
  assert.ok(html.includes('d="M'));
  assert.ok(!html.includes("NaN"));
});
check("缺失 RSSI 不补零或伪造第二通道", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, rssi: [null, null, null] }} kind="rssi" />);
  assert.ok(html.includes("等待 RSSI 数据"));
  const actual = renderToStaticMarkup(<FieldWaveChart waveform={waveform} kind="rssi" />);
  assert.ok(!actual.includes("NaN"));
  assert.ok(actual.includes("单位百分比"));
});
check("采集启用必须同时满足服务和 DLL 就绪", () => {
  assert.equal(fieldCanStart(ready), true);
  assert.equal(fieldCanStart(null), false);
  assert.equal(fieldCanStart({ ...ready, service: { state: "missing", dllConfigured: true } }), false);
  assert.equal(fieldCanStart({ ...ready, service: { state: "ready", dllConfigured: false } }), false);
  assert.equal(fieldCanStart({ ...ready, state: "error", receiver: { running: true } }), false);
  assert.equal(fieldIsActive({ ...ready, state: "error", receiver: { running: true } }), true);
  for (const state of ["starting", "acquiring", "stopping"] as const) {
    assert.equal(fieldCanStart({ ...ready, state }), false);
    assert.equal(fieldIsActive({ ...ready, state }), true);
  }
});
check("模拟输入必须显式选择，免设备 DLL 但仍要求可用服务且无正在运行的采集", () => {
  const noDll: FieldStatus = { ...ready, service: { state: "ready", dllConfigured: false, launcher: "python-module" } };
  assert.equal(fieldCanStart(noDll), false, "省略来源仍表示设备采集，不自动回退模拟");
  assert.equal(fieldCanStart(noDll, "device"), false);
  assert.equal(fieldCanStart(noDll, "simulation"), true);
  assert.equal(fieldCanStart(null, "simulation"), false);
  for (const state of ["missing", "starting", "error", "stopping", "stopped"] as const) {
    assert.equal(fieldCanStart({ ...noDll, service: { ...noDll.service, state } }, "simulation"), false);
  }
  for (const state of ["starting", "acquiring", "stopping"] as const) {
    assert.equal(fieldCanStart({ ...noDll, state }, "simulation"), false);
  }
  assert.equal(fieldCanStart({ ...noDll, state: "error", receiver: { running: true } }, "simulation"), false);
  assert.equal(fieldCanStart({ ...noDll, deviceBusy: true }, "simulation"), false);
});
check("Python Unix 秒和 ISO 日期都能显示正确年份", () => {
  assert.equal(fieldDate(1788915600)?.toISOString(), "2026-09-09T01:00:00.000Z");
  assert.equal(fieldDate("2026-09-09T01:00:00Z")?.getTime(), fieldDate(1788915600)?.getTime());
  assert.equal(fieldDate("invalid"), null);
  assert.equal(fieldDate(undefined), null);
});
check("IP 和任务验证不会使用自动预设设备地址", () => {
  const config = { name: "真实任务", object: "", turbine: "", point: "", deviceIp: "192.168.1.2", hostIp: "192.168.1.3" };
  assert.equal(validateFieldConfig(config), null);
  assert.ok(validateFieldConfig({ ...config, name: " " }));
  assert.ok(validateFieldConfig({ ...config, hostIp: "192.168.1.2" }));
  assert.ok(validateFieldConfig({ ...config, deviceIp: "999.168.1.2" }));
  assert.ok(validateFieldConfig({ ...config, hostIp: "" }));
});
check("缺失服务展示配置入口，不回退演示", () => {
  const html = renderToStaticMarkup(<FieldServicePanel status={{ ...ready, service: { state: "missing", dllConfigured: false } }} busy={false} onAction={() => {}} />);
  assert.ok(html.includes("采集服务未安装"));
  assert.ok(html.includes("选择采集服务 EXE"));
  assert.ok(html.includes("不能开始真实采集"));
});
check("登录仅预填 admin 用户名，不显示密码或离线演示入口", () => {
  const html = renderToStaticMarkup(<FieldLoginPanel busy={false} error="" available={true} onLogin={async () => {}} />);
  assert.ok(html.includes('value="admin"'));
  assert.match(html, /type="password"[^>]*value=""/);
  assert.ok(!html.includes("离线演示"));
  assert.ok(html.includes("首次登录必须修改密码"));
});
check("浏览器预览没有本机桥接时禁止登录", () => {
  const html = renderToStaticMarkup(<FieldLoginPanel busy={false} error="" available={false} onLogin={async () => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>/);
  assert.ok(html.includes("不提供本机登录与设备采集"));
});
const unifiedAccount: FieldAccountInfo = { mode: "unified", serverUrl: "https://blade.example.com", username: "field_operator", lastVerifiedAt: 1790000000000, offlineUntil: 1792592000000, offline: true };
check("绑定后登录固定 Web 账号，标明离线期限且不出现本机管理员提示", () => {
  const html = renderToStaticMarkup(<FieldLoginPanel account={unifiedAccount} busy={false} error="" available onLogin={async () => {}} />);
  assert.match(html, /<input(?=[^>]*name="username")(?=[^>]*readOnly="")(?=[^>]*value="field_operator")[^>]*>/i);
  assert.match(html, /type="password"[^>]*value=""/);
  assert.ok(html.includes("Web 账号密码"));
  assert.ok(html.includes("https://blade.example.com"));
  assert.ok(html.includes(fieldAccountTime(unifiedAccount.offlineUntil)));
  assert.ok(html.includes("最多有效 30 天"));
  assert.ok(html.includes("不回退旧本机账号"));
  assert.ok(!html.includes('value="admin"'));
  assert.ok(!html.includes("预制管理员账号"));
});
check("统一账号需要联网时不宣称缓存可用，配置失败也不启用本机回退", () => {
  const required = renderToStaticMarkup(<FieldLoginPanel account={{ ...unifiedAccount, onlineRequired: true }} busy={false} error="" available onLogin={async () => {}} />);
  assert.ok(required.includes("本次登录需要联网验证，离线缓存不可用"));
  const unavailable = renderToStaticMarkup(<FieldLoginPanel account={null} accountUnavailable busy={false} error="读取失败" available onRetry={() => {}} onLogin={async () => {}} />);
  assert.match(unavailable, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.ok(unavailable.includes("重新读取账号配置"));
  assert.ok(unavailable.includes("不会因读取失败而切换账号来源"));
  assert.ok(!unavailable.includes("预制管理员账号"));
});
check("账号卡片只展示安全元信息，绑定后无换绑入口", () => {
  const extraMetadata = { ...unifiedAccount, token: "TOKEN_MUST_NOT_RENDER", passwordHash: "HASH_MUST_NOT_RENDER", salt: "SALT_MUST_NOT_RENDER" };
  const html = renderToStaticMarkup(<FieldAccountPanel account={extraMetadata} busy={false} active={false} onBind={() => {}} onPassword={() => {}} />);
  for (const label of ["账号与密码", "Web 服务器", "绑定账号", "上次联网验证", "离线有效期至", "统一账号 · 离线验证", "修改统一密码", "下次联网登录时校验"]) assert.ok(html.includes(label));
  assert.ok(!html.includes("绑定 Web 账号"));
  assert.ok(!html.includes("<input"));
  for (const secret of [extraMetadata.token, extraMetadata.passwordHash, extraMetadata.salt]) assert.ok(!html.includes(secret));
});
check("未绑定账号提供显式绑定且运行采集时禁止账号变更", () => {
  const local = renderToStaticMarkup(<FieldAccountPanel account={{ mode: "local" }} busy={false} active={false} onBind={() => {}} onPassword={() => {}} />);
  assert.ok(local.includes("绑定 Web 账号")); assert.ok(local.includes("修改本机密码"));
  assert.ok(local.includes("原有采集记录保留在本机")); assert.ok(local.includes("不会因绑定自动上传"));
  for (const account of [{ mode: "local" } as FieldAccountInfo, unifiedAccount]) {
    const running = renderToStaticMarkup(<FieldAccountPanel account={account} busy={false} active onBind={() => {}} onPassword={() => {}} />);
    const buttons = [...running.matchAll(/<button([^>]*)>/g)];
    assert.ok(buttons.length > 0); assert.ok(buttons.every(button => button[1].includes('disabled=""')));
    assert.ok(running.includes("请先停止并保存采集"));
  }
});
check("绑定表单验证双方密码且不预填凭据，提交区独立于滚动正文", () => {
  const html = renderToStaticMarkup(<FieldBindAccountDialog busy={false} error="" onClose={() => {}} onBind={async () => {}} />);
  for (const name of ["currentPassword", "serverUrl", "username", "password"]) assert.match(html, new RegExp(`<input(?=[^>]*name="${name}")(?=[^>]*required="")[^>]*>`));
  assert.equal((html.match(/type="password"/g) || []).length, 2);
  assert.equal((html.match(/type="password"[^>]*value=""/g) || []).length, 2);
  assert.match(html, /name="serverUrl"[^>]*value=""/);
  assert.ok(html.includes("服务器与账号不能更换"));
  assert.ok(html.includes("旧本机密码不再用于登录"));
  assert.ok(html.includes('</p></div><div class="field-form-actions">'));
  assert.ok(html.includes("确认绑定并使用统一账号"));
});
check("发布版默认线上 Web 地址，开发端口保留本机地址，账号时间戳按毫秒处理", () => {
  for (const hostname of ["127.0.0.1", "localhost"]) assert.equal(fieldAccountServerDefault({ protocol: "http:", hostname, port: "5210" }), "http://127.0.0.1:3210");
  assert.equal(fieldAccountServerDefault({ protocol: "file:", hostname: "", port: "" }), "http://115.190.201.41:3000");
  for (const location of [undefined, { protocol: "http:", hostname: "blade.example.com", port: "5210" }, { protocol: "http:", hostname: "127.0.0.1", port: "3210" }]) assert.equal(fieldAccountServerDefault(location), "");
  assert.equal(fieldAccountTime(unifiedAccount.lastVerifiedAt), new Date(unifiedAccount.lastVerifiedAt!).toLocaleString("zh-CN", { hour12: false }));
  assert.equal(fieldAccountTime(Number.NaN), "尚无验证记录");
  const info: FieldRequestOptions = { action: "accountInfo" };
  const bind: FieldRequestOptions = { action: "bindAccount", serverUrl: "https://blade.example.com", username: "field_operator", password: "", currentPassword: "" };
  assert.deepEqual(Object.keys(info), ["action"]);
  assert.deepEqual(Object.keys(bind).sort(), ["action", "currentPassword", "password", "serverUrl", "username"]);
});
check("远程 HTTP 在绑定和账号页提示明文传输，本机与 HTTPS 不显示提示", () => {
  for (const serverUrl of ["http://115.190.201.41:3000", "http://192.168.1.10", "http://web.example.com"]) {
    assert.equal(fieldAccountUsesPlainHttp(serverUrl), true);
    const form = renderToStaticMarkup(<FieldBindAccountDialog busy={false} error="" initialServerUrl={serverUrl} onClose={() => {}} onBind={async () => {}} />);
    assert.ok(form.includes("账号、密码和会话信息将明文传输"));
    const card = renderToStaticMarkup(<FieldAccountPanel account={{ ...unifiedAccount, serverUrl }} busy={false} active={false} onBind={() => {}} onPassword={() => {}} />);
    assert.ok(card.includes("账号、密码和会话信息将明文传输"));
  }
  for (const serverUrl of [undefined, "", "invalid", "http://127.0.0.1:3210", "http://localhost:3210", "http://[::1]:3210", "https://blade.example.com"]) assert.equal(fieldAccountUsesPlainHttp(serverUrl), false);
});
check("统一密码页保留三项输入和 12–128 位校验，说明联网与其他桌面离线边界", () => {
  const html = renderToStaticMarkup(<FieldPasswordPanel account={unifiedAccount} mandatory={false} busy={false} error="" onSave={async () => {}} onCancel={() => {}} />);
  assert.equal((html.match(/type="password"/g) || []).length, 3);
  assert.equal((html.match(/minLength="12"/g) || []).length, 2);
  assert.equal((html.match(/maxLength="128"/g) || []).length, 2);
  for (const text of ["修改统一密码", "需要联网", "Web 与所有已绑定桌面", "下次联网登录", "不会强制中断", "30 天有效期"]) assert.ok(html.includes(text));
  assert.ok(!html.includes("修改仅影响这台电脑"));
});
check("记录空态不预置数据", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes("还没有采集记录"));
  assert.ok(html.includes("完成设备或模拟采集后"));
  assert.ok(!html.includes("<table"));
});
check("模拟记录必须展示来源且不会因模拟来源掩盖异常状态", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[{ id: "simulation", name: "模拟风机", source: "simulation", simulation: { point: "P2", scenario: "impact" }, samples: 1200, sampleRate: 2000, startedAt: "2026-09-22T01:00:00Z", status: "error", error: "write failed" }]} busy={false} onSelect={() => {}} />);
  assert.match(html, />模拟<\/span>/);
  assert.ok(html.includes("异常记录"));
  assert.ok(!html.includes("已完成"));
});
check("记录契约使用 samples / endedAt / status，异常不能显示完成", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[{ id: "test", name: "实测记录", samples: 1200, sampleRate: 2000, startedAt: "2026-09-09T01:00:00Z", endedAt: "2026-09-09T01:00:01Z", status: "error", error: "device disconnected" }]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes("1,200"));
  assert.ok(html.includes("异常记录"));
  assert.ok(!html.includes("已完成"));
});
check("采集确认正文与操作区分离，三个安全条件仍须逐项确认", () => {
  const html = renderToStaticMarkup(<FieldStartDialog config={{ name: "窗口适配测试", deviceIp: "192.168.1.2", hostIp: "192.168.1.3", object: "", turbine: "", point: "" }} busy={false} error="" onClose={() => {}} onStart={() => {}} />);
  assert.ok(html.includes('class="field-confirm-body"'));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes('</label></div><div class="field-form-actions">'), "操作区必须位于可滚动的确认正文外");
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*?确认并开始采集<\/button>/);
  assert.ok(html.includes('aria-label="关闭弹窗"'));
});
check("窄屏记录表保留所有列并提供键盘可聚焦的横向滚动区域", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={[{ id: "long", name: "户外叶片采集任务".repeat(10), startedAt: "2026-09-09T01:00:00Z", samples: 500000, sampleRate: 218750, status: "incomplete" }]} busy={false} onSelect={() => {}} />);
  assert.ok(html.includes('role="region"'));
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(html.includes("可横向滚动查看所有列"));
  for (const column of ["任务 / 对象", "开始时间", "原始点数", "采样率", "保存状态", "操作"]) assert.ok(html.includes(column));
  assert.ok(html.includes("查看波形"));
});
check("原始数据导出仅允许完整记录，异常或采集中记录保持禁用", () => {
  const html = renderToStaticMarkup(<FieldRecordingList recordings={(["complete", "incomplete", "error"] as const).map(status => ({ id: status, name: status, source: "simulation", samples: 2048, sampleRate: 2000, startedAt: "2026-09-22T01:00:00Z", status }))} busy={false} onSelect={() => {}} onExport={() => {}} />);
  const buttons = [...html.matchAll(/<button([^>]*)>导出原始数据<\/button>/g)];
  assert.equal(buttons.length, 3);
  assert.ok(!buttons[0][1].includes("disabled"));
  assert.ok(buttons[1][1].includes("disabled"));
  assert.ok(buttons[2][1].includes("disabled"));
});
check("低高度密码页保留三项输入、保存及退出登录入口", () => {
  const html = renderToStaticMarkup(<FieldPasswordPanel mandatory busy={false} error="" onSave={async () => {}} onCancel={() => {}} />);
  assert.equal((html.match(/type="password"/g) || []).length, 3);
  assert.equal((html.match(/minLength="12"/g) || []).length, 2);
  assert.ok(html.includes("保存新密码"));
  assert.ok(html.includes("退出登录"));
});
check("全程浏览平移和缩放限制在已采集区间", () => {
  assert.deepEqual(clampWaveRange(-100, 100, 1000), [0, 200]);
  assert.deepEqual(clampWaveRange(900, 1200, 1000), [700, 1000]);
  assert.deepEqual(clampWaveRange(5, 5, 1000), [5, 6]);
  assert.deepEqual(waveBounds({ ...waveform, rangeStart: 0, rangeEnd: 900 }), [0, 900]);
});
check("实际时间使用 sampleOrigin 而非任务创建时间，未知起点不伪造", () => {
  const wave = { ...waveform, sampleOrigin: 1700000000 };
  assert.ok(formatWaveTime(1000, wave, "clock").endsWith(".500"));
  assert.equal(formatWaveTime(1000, { ...wave, sampleOrigin: null }, "clock"), "500");
});
check("固定纵轴不按微小噪声自动跳动，超显示范围明确提示", () => {
  const small = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [0, 0.000016785, 0] }} yLimit={0.5} unit="mm/s" />);
  assert.ok(small.includes("500"));
  const large = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [1, 0, -1] }} yLimit={0.5} />);
  assert.ok(large.includes("这不等于设备超量程"));
});
check("实时帧不会覆盖正在编辑或待修正的固定纵轴草稿", () => {
  let state: WaveScaleDraft = { draft: "", unit: "mm/s", editing: false, invalid: false };
  state = waveScaleDraft(state, { type: "sync", scale: 0.005, unit: "mm/s" });
  assert.equal(state.draft, "5");
  state = waveScaleDraft(state, { type: "focus" });
  state = waveScaleDraft(state, { type: "edit", draft: "0.00" });
  for (let frame = 0; frame < 20; frame++) state = waveScaleDraft(state, { type: "sync", scale: 0.02 + frame * 0.001, unit: "mm/s" });
  assert.equal(state.draft, "0.00", "小数输入必须在持续采集刷新中完整保留");
  state = waveScaleDraft(state, { type: "commit", valid: false });
  state = waveScaleDraft(state, { type: "sync", scale: 0.9, unit: "mm/s" });
  assert.equal(state.invalid, true); assert.equal(state.draft, "0.00");
  state = waveScaleDraft(state, { type: "edit", draft: "0.0025" });
  state = waveScaleDraft(state, { type: "commit", valid: true });
  state = waveScaleDraft(state, { type: "sync", scale: 0.0000025, unit: "mm/s" });
  assert.equal(state.invalid, false); assert.equal(state.draft, "0.0025");
  state = waveScaleDraft(state, { type: "focus" });
  state = waveScaleDraft(state, { type: "sync", scale: 0.0000025, unit: "m/s" });
  assert.equal(Number(state.draft), 0.0000025, "单位切换必须转换数值，不能沿用另一单位的草稿");
});
check("包络按实际区间定位，不伪造连续原始采样点", () => {
  const html = renderToStaticMarkup(<FieldWaveChart waveform={{ ...waveform, values: [], rssi: [], rangeStart: 0, rangeEnd: 10000, representation: "envelope", envelope: [{ start: 0, end: 10000, min: -1, max: 9, rssiMin: 79, rssiMax: 83, missing: 1, overrange: 0 }] }} />);
  assert.ok(html.includes('class="field-wave-svg'));
  assert.ok(html.includes('d="M'));
  assert.ok(!html.includes("NaN"));
});
check("设备操作进行中禁止启动，旧记录无配置不填默认值", () => {
  assert.equal(fieldCanStart({ ...ready, deviceBusy: true }), false);
  const html = renderToStaticMarkup(<FieldDeviceSnapshot />);
  assert.ok(html.includes("不能用当前设备设置代替"));
  assert.ok(!html.includes("10 kHz"));
});


check("同步设置明确仅自动上传新采集，未绑定时开关不可用", () => {
  const local = renderToStaticMarkup(<FieldCloudSyncPanel account={{ mode: "local" }} status={{ enabled: true, connected: false, state: "unbound", items: [] }} busy={false} onAuto={() => {}} onRetry={() => {}} />);
  assert.match(local, /role="switch"[^>]*disabled=""/);
  assert.ok(local.includes("请先绑定 Web 账号"));
  const connected = renderToStaticMarkup(<FieldCloudSyncPanel account={unifiedAccount} status={{ enabled: true, connected: true, state: "ready", items: [{ recordingId: "one", name: "new capture", state: "uploading", progress: 45 }] }} busy={false} onAuto={() => {}} onRetry={() => {}} />);
  assert.ok(connected.includes("历史记录可在本机记录中逐条上传"));
  assert.ok(connected.includes("45%")); assert.ok(connected.includes("重试同步"));
});
console.log(`Field desktop presentation checks: ${checks} passed (static/pure only).`);
