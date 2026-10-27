// Real Web UI in an isolated Chromium window, with isolated project DB groups.
const { app, BrowserWindow } = require("electron"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  mysql = require("mysql2/promise"),
  { randomBytes, createHash } = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "artifacts/server-unified-ui-20261027");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
if (process.env.DB_NAME !== "blade_vms_playground")
  throw Error("Refusing non-project DB");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(out, "profile-")));
app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:3210",
  tenant = "qa_measurement_ui_" + Date.now(),
  emptyTenant = tenant + "_empty",
  password = randomBytes(18).toString("base64url"),
  users = [],
  tokens = {},
  tests = [];
let rootToken, db, failure, win;
const accounts = [];
async function api(p, method = "GET", body, token = rootToken) {
  const res = await fetch(origin + "/api/v1/" + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw Error(p + ": " + res.status + " " + data.error);
  return data;
}
const js = (code) => win.webContents.executeJavaScript(code, true);
async function until(condition) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (typeof condition === "string" ? await js(condition) : await condition())
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("UI timeout: " + condition);
}
async function click(text) {
  await until(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute("aria-label")===${JSON.stringify(text)})); if(!b||b.disabled)return false; b.scrollIntoView({block:'nearest'}); b.click(); return true })()`,
  );
}
async function setField(label, value, select = false) {
  await js(
    `(() => { const label=${JSON.stringify(label)}; const el=[...document.querySelectorAll(${JSON.stringify(select ? "select" : "input,textarea")})].find(e=>e.getAttribute('aria-label')===label||e.closest('label')?.querySelector('span')?.textContent.replaceAll('*','').trim()===label); if(!el)throw Error('Missing field: '+label); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "(el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement)"}.prototype,'value').set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")},{bubbles:true})); })()`,
  );
}
async function capture(name) {
  await js(
    "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
  );
  fs.writeFileSync(
    path.join(out, name + ".png"),
    (await win.webContents.capturePage()).toPNG(),
  );
}
async function check(name, fn) {
  await fn();
  tests.push({ name, result: "pass" });
  console.log("PASS " + name);
}
async function login(role) {
  if (win) win.destroy();
  win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 768,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: tenant + role,
    },
  });
  await win.loadURL(origin);
  await until("!!document.querySelector('.login-card')");
  await setField("账号", tenant + "_" + role);
  await setField("密码", password);
  await click("登录");
  await until("!!document.querySelector('nav.sidebar')");
}
// Test records belong only to temporary QA accounts and are removed in finally.
// No fixtures are added to a real user's imports or desktop capture storage.
async function response(p, method, body, token) {
  const res = await fetch(origin + "/api/v1/" + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error("Measurement UI timeout");
    app.exit(1);
  }, 240000);
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    rootToken = (
      await api(
        "session",
        "POST",
        { username: "admin", password: process.env.BOOTSTRAP_PASSWORD },
        "",
      )
    ).token;
    for (const role of ["admin", "analyst", "operator", "viewer", "empty"]) {
      const group = role === "empty" ? emptyTenant : tenant,
        username = tenant + "_" + role;
      const u = await api("users", "POST", {
        username,
        password,
        name: "QA " + role,
        role: role === "empty" ? "viewer" : role,
        tenant: group,
      });
      users.push(u.id);
      accounts.push({ id: u.id, tenant: group });
      tokens[role] = (
        await api("session", "POST", { username, password }, "")
      ).token;
    }
    const a = (p, m = "GET", b) => api(p, m, b, tokens.admin);
    const create = async (kind, code, parentId, extra = {}) =>
      (
        await a("objects", "POST", {
          kind,
          code,
          name: code,
          parentId,
          ...extra,
        })
      ).object;
    let farm,
      turbines = [],
      campaign,
      objects,
      results = [],
      fixtures = [];
    await check("认证、课题组隔离与只读权限", async () => {
      assert.equal(
        (await response("objects", "GET", undefined, "")).status,
        401,
      );
      assert.equal(
        (
          await response(
            "objects",
            "POST",
            { kind: "farm", code: "F", name: "F" },
            tokens.viewer,
          )
        ).status,
        403,
      );
      farm = await create("farm", "QA风场", null);
      assert.equal(
        (await api("objects", "GET", undefined, tokens.empty)).objects.length,
        0,
      );
      assert.equal(
        (await response("wind-datasets", "POST", {}, tokens.viewer)).status,
        403,
      );
    });
    await check("两台风机、3×5空点位与一个跨风机批次；旧修订冲突", async () => {
      for (const code of ["QA-WT01", "QA-WT02"]) {
        const t = await create("turbine", code, farm.id);
        turbines.push(t);
        await a("objects/default-points", "POST", { turbineId: t.id });
      }
      campaign = await create("campaign", "QA现场批次", farm.id, {
        turbineIds: turbines.map((t) => t.id),
        date: "2026-10-01",
        operators: "QA",
      });
      objects = (await a("objects")).objects;
      assert.equal(objects.filter((o) => o.kind === "position").length, 30);
      await a("objects", "POST", { ...farm, name: "QA风场更新" });
      assert.equal(
        (
          await response(
            "objects",
            "POST",
            { ...farm, name: "过期修改" },
            tokens.admin,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await response(
            "objects",
            "POST",
            { kind: "position", code: "PX", name: "PX", parentId: farm.id },
            tokens.admin,
          )
        ).status,
        400,
      );
    });
    await check("CSV工况预览、时间窗数据校验、重复拒绝", async () => {
      const raw =
        "time,turbineCode,windSpeed,rpm\n2026-10-01T02:00:00Z,QA-WT01,3,12\n2026-10-01T02:00:00Z,QA-WT02,3,12";
      const preview = await a("wind-datasets/preview", "POST", {
        filename: "qa.csv",
        base64: Buffer.from(raw).toString("base64"),
      });
      assert.equal(preview.rows.length, 2);
      const rows = preview.rows.map((r) => ({
        time: r[0],
        turbineCode: r[1],
        windSpeed: +r[2],
        rpm: +r[3],
      }));
      assert.equal(
        (
          await response(
            "wind-datasets",
            "POST",
            {
              name: "bad",
              farmId: farm.id,
              rows: [{ ...rows[0], time: "2026-10-01 10:00:00" }],
            },
            tokens.admin,
          )
        ).status,
        400,
      );
      await a("wind-datasets", "POST", {
        name: "QA风速记录",
        farmId: farm.id,
        rows,
      });
      assert.equal(
        (
          await response(
            "wind-datasets",
            "POST",
            { name: "duplicate", farmId: farm.id, rows },
            tokens.admin,
          )
        ).status,
        409,
      );
    });
    await check(
      "真实Python链路：导入、对象归属、有效片段Welch、结果入库与工况匹配",
      async () => {
        for (let i = 0; i < 6; i++) {
          const t = turbines[i === 5 ? 1 : 0],
            blade = objects.find(
              (o) =>
                o.kind === "blade" && o.parentId === t.id && o.code === "1",
            ),
            position = objects.find(
              (o) =>
                o.kind === "position" &&
                o.parentId === blade.id &&
                o.code === `P${i === 5 ? 1 : i + 1}`,
            );
          const metadata = {
            format: "blade-vms-csv-1",
            recordingId: String(i + 1).padStart(32, "0"),
            name: `QA实测流程${i + 1}`,
            source: "measured",
            windFarm: farm.code,
            turbine: t.code,
            sampleRate: 1000,
            samples: 2000,
            sampleOrigin: Date.parse("2026-10-01T02:00:00Z") / 1000,
            rssiSampleStride: 1,
            rssiSampleRate: 1000,
            pointCycle: {
              mode: "automatic_stations",
              collectionId: "c".repeat(32),
              bladeId: "1",
              sessionId: "d".repeat(32),
              radialPointId: position.code,
              radialPointName: position.code,
              radiusM: (i + 1) * 0.1,
              azimuthDeg: 0,
              stationId: position.code + "-0",
              stationIndex: 1,
              stationCount: 4,
              lapIndex: 1,
              completion: "confirmed_pass",
              outcome: "observed",
              identityVerified: false,
              coverageKind: "sparse_station_passes",
              handoff: {
                reason: "blade_left",
                entrySampleIndex: 180,
                entryConfirmedSampleIndex: 199,
                exitSampleIndex: 1600,
                exitConfirmedSampleIndex: 1629,
              },
            },
          };
          const csv =
            "# BladeVMS " +
            JSON.stringify(metadata) +
            "\ntime_s,velocity_m_s,RSSI_percent,overrange\n" +
            Array.from(
              { length: 2000 },
              (_, k) =>
                `${k / 1000},${0.001 * (i + 1) * (i === 4 && k >= 800 && k < 1000 ? 8 : 1) * Math.sin((2 * Math.PI * 50 * k) / 1000)},80,0`,
            ).join("\n");
          const res = await fetch(
            origin + "/api/v1/rotation/import?filename=qa.csv&source=measured",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + tokens.admin,
                "Content-Type": "text/csv",
              },
              body: csv,
            },
          );
          const imported = await res.json();
          assert.equal(res.status, 201, JSON.stringify(imported));
          const reference = { kind: "import", id: imported.recordings[0].id };
          fixtures.push(csv);
          if (i === 0)
            assert.equal(
              (
                await response(
                  "measurements/analyze",
                  "POST",
                  { reference },
                  tokens.admin,
                )
              ).status,
              400,
            );
          await a("objects/link", "POST", {
            reference,
            revision: null,
            context: {
              farmId: farm.id,
              turbineId: t.id,
              bladeId: blade.id,
              positionId: position.id,
              campaignId: campaign.id,
            },
          });
          const r = (
            await a("measurements/analyze", "POST", {
              reference,
              parameters: { windowSeconds: 1 },
            })
          ).result;
          results.push(r);
          if (i === 4) {
            assert.equal(r.features.events.length, 1);
            assert.equal(r.features.events[0].sourceStartSample, 800);
            assert.equal(r.features.events[0].sourceEndSample, 1000);
            assert.equal(r.features.events[0].confidence, null);
          }
          assert.equal(r.features.peaks[0].frequencyHz, 50);
          assert.equal(r.condition.status, "matched");
          assert.equal(r.condition.windSpeed, 3);
          assert.equal(r.assessment.status, "insufficient");
          assert.ok(
            r.features.validSeconds > 1.3 && r.features.validSeconds < 1.5,
          );
          assert.equal(r.features.phaseAvailable, false);
        }
        assert.equal(
          (await api("measurements", "GET", undefined, tokens.empty)).results
            .length,
          0,
        );
        assert.equal(
          (
            await response(
              "measurements/result/" + results[0].id,
              "GET",
              undefined,
              tokens.empty,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await response(
              "measurements/analyze",
              "POST",
              { reference: results[0].reference },
              tokens.viewer,
            )
          ).status,
          403,
        );
        const summary = await a("measurements");
        assert.equal(summary.results[0].features.stitch, undefined);
      },
    );
    await check(
      "并发工况导入不会重复、合并分析拒绝跨点位和重复原记录",
      async () => {
        const b = {
          name: "并发导入",
          farmId: farm.id,
          rows: [
            {
              time: "2026-10-02T02:00:00Z",
              turbineCode: turbines[0].code,
              windSpeed: 3,
              rpm: 12,
            },
          ],
        };
        const responses = await Promise.all([
          response("wind-datasets", "POST", b, tokens.admin),
          response("wind-datasets", "POST", b, tokens.admin),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          (
            await response(
              "measurements/analyze",
              "POST",
              { references: [results[0].reference, results[1].reference] },
              tokens.admin,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await response(
              "measurements/analyze",
              "POST",
              { references: [results[0].reference, results[0].reference] },
              tokens.admin,
            )
          ).status,
          400,
        );
      },
    );
    await check("操作员不能通过分析摘要、模态或报告读取同事数据", async () => {
      assert.equal(
        (await api("measurements", "GET", undefined, tokens.operator)).results
          .length,
        0,
      );
      assert.equal(
        (
          await response(
            "measurements/result/" + results[0].id,
            "GET",
            undefined,
            tokens.operator,
          )
        ).status,
        404,
      );
    });
    await check("复核、参考批准与判据修改可追溯，无隐式基线", async () => {
      await a("measurements/review", "POST", {
        resultId: results[0].id,
        note: "QA核对原始有效段",
        status: "已确认",
        referenceApproved: true,
        revision: null,
      });
      assert.equal(
        (
          await response(
            "measurements/review",
            "POST",
            {
              resultId: results[1].id,
              note: "越界",
              status: "待复核",
              referenceApproved: false,
              revision: null,
              range: { startSeconds: 0, endSeconds: 999 },
            },
            tokens.admin,
          )
        ).status,
        400,
      );
      await a("measurements/review", "POST", {
        resultId: results[1].id,
        note: "QA有效片段标记",
        status: "待复核",
        referenceApproved: false,
        revision: null,
        range: { startSeconds: 0.1, endSeconds: 0.3 },
      });
      assert.equal(
        (await a("measurements/result/" + results[1].id)).result.review.range
          .endSeconds,
        0.3,
      );
      const detail = (await a("measurements/result/" + results[0].id)).result;
      assert.equal(detail.referenceApproved, true);
      assert.ok(detail.review.revision);
      assert.equal(
        (
          await response(
            "measurements/review",
            "POST",
            {
              resultId: results[0].id,
              note: "old",
              status: "已确认",
              referenceApproved: false,
              revision: null,
            },
            tokens.admin,
          )
        ).status,
        409,
      );
      const state = await a("measurements/rules");
      assert.equal(state.revision, null);
      await a("measurements/rules", "PUT", {
        ...state,
        rules: { ...state.rules, sigma: 3 },
      });
      assert.equal(
        (await response("measurements/rules", "PUT", state, tokens.admin))
          .status,
        409,
      );
      const rerun = (
        await a("measurements/reassess", "POST", { resultId: results[0].id })
      ).result;
      assert.ok(rerun.features.stitch.raw.length);
      assert.ok(
        (await a("measurements/result/" + rerun.id)).result.features.waveform
          .length,
      );
    });
    await check("五点真实响应、缺失叶片不补值、真实报告Word导出", async () => {
      const r = (
        await a("measurements/modal", "POST", {
          campaignId: campaign.id,
          turbineId: turbines[0].id,
          azimuthDeg: 0,
          frequencyHz: 50,
        })
      ).result;
      assert.equal(r.curves.length, 3);
      assert.equal(
        r.curves[0].points.filter((p) => p.amplitudeMps !== null).length,
        5,
      );
      assert.equal(r.curves[1].points[0].amplitudeMps, null);
      const report = (
        await a("measurements/reports", "POST", { campaignId: campaign.id })
      ).report;
      assert.equal(report.rows.length, 6);
      assert.ok(report.reportNumber.includes("MULTI"));
      assert.equal(report.rows.flatMap((r) => r.events).length, 1);
      assert.equal(
        new Set(report.rows.map((r) => r.context.turbineId)).size,
        2,
      );
      const res = await fetch(
        origin + "/api/v1/measurements/report-download/" + report.id,
        { headers: { Authorization: "Bearer " + tokens.admin } },
      );
      assert.equal(res.status, 200, res.status===200 ? "" : await res.text());
      assert.equal(
        (await api("measurements/reports", "GET", undefined, tokens.operator))
          .reports.length,
        0,
      );
      assert.equal(
        (await api("measurements/modal", "GET", undefined, tokens.operator))
          .results.length,
        0,
      );
      const denied = await fetch(
        origin + "/api/v1/measurements/report-download/" + report.id,
        { headers: { Authorization: "Bearer " + tokens.operator } },
      );
      assert.equal(denied.status, 404);
      const bytes = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(out, "qa-report.docx"), bytes);
      const zip = await require("jszip").loadAsync(bytes);
      const xml = await zip.file("word/document.xml").async("string");
      assert.ok(xml.includes("QA-WT01"));
      assert.ok(xml.includes("QA-WT02"));
      assert.ok(xml.includes("未测量"));
      assert.ok(xml.includes("频率偏移% / 幅值比"));
      assert.ok(xml.includes("波形异常候选"));
      assert.ok(!xml.includes("叶尖裂纹-CNN"));
    });
    await check(
      "业务快照包含新对象、工况和结果，隔离课题组恢复验证",
      async () => {
        const backup = await a("backups", "POST", {});
        await create("turbine", "QA临时新增", farm.id);
        await a("backups/restore", "POST", {
          id: backup.id,
          confirm: "恢复业务数据",
        });
        const restored = await a("measurements");
        assert.ok(!restored.objects.some((o) => o.code === "QA临时新增"));
        assert.ok(restored.results.length >= 6);
        assert.equal((await a("wind-datasets")).datasets.length, 2);
      },
    );
    await check(
      "同点同角度多次经过合并保持频率分辨率，并保留每条来源",
      async () => {
        const lines = fixtures[0].split("\n"),
          meta = JSON.parse(lines[0].slice(11));
        meta.name = "QA第二次经过";
        meta.recordingId = "f".repeat(32);
        meta.sampleOrigin += 3;
        const body =
          "# BladeVMS " +
          JSON.stringify(meta) +
          "\n" +
          lines.slice(1).join("\n");
        const res = await fetch(
          origin +
            "/api/v1/rotation/import?filename=second.csv&source=measured",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + tokens.admin,
              "Content-Type": "text/csv",
            },
            body,
          },
        );
        const imported = await res.json();
        assert.equal(res.status, 201, JSON.stringify(imported));
        const reference = { kind: "import", id: imported.recordings[0].id };
        await a("objects/link", "POST", {
          reference,
          revision: null,
          context: results[0].context,
        });
        const combined = (
          await a("measurements/analyze", "POST", {
            references: [results[0].reference, reference],
            parameters: { windowSeconds: 1 },
          })
        ).result;
        assert.equal(combined.sourceKeys.length, 2);
        assert.equal(combined.features.stitch.joins.length, 1);
        assert.equal(combined.features.peaks[0].frequencyHz, 50);
        assert.equal(combined.features.spectrum.resolutionHz, 1);
        assert.equal(combined.features.provenance.sources.length, 2);
      },
    );
    await check("原始波形按权限读取并保留全程边界", async () => {
      const summary = await a("measurements");
      const source = summary.sources[0];
      const raw = await a("measurements/source-waveform", "POST", {
        reference: source.reference,
      });
      assert.equal(raw.recording.samples, 2000);
      assert.equal(raw.waveform.rangeStart, 0);
      const denied = await response(
        "measurements/source-waveform",
        "POST",
        { reference: source.reference },
        tokens.empty,
      );
      assert.equal(denied.status, 404);
    });
    await login("admin");
    await check("默认旋转测振与导航顺序、真实记录可见", async () => {
      await until(
        "document.querySelector('main').textContent.includes('有效波形与频谱')",
      );
      assert.deepEqual(
        await js(
          "[...document.querySelectorAll('nav.sidebar>button,nav.sidebar button')].map(b=>b.textContent.trim())",
        ),
        [
          "旋转测振",
          "模态识别",
          "风场数据集",
          "健康监测",
          "报告导出",
          "二次开发",
          "系统管理",
        ],
      );
      await until(
        "document.querySelector('main').textContent.includes('QA实测流程1')",
      );
      await capture("rotation-1366");
      await until("document.querySelectorAll('main canvas').length>=2");
      assert.equal(await js("document.querySelectorAll('main h1').length"), 1);
      win.setContentSize(1440, 1100);
      await capture("analysis-detail-1440");
      win.setContentSize(1366, 768);
      await click("原始记录");
      await until(
        "!!document.querySelector('.field-wave-chart') || !!document.querySelector('main svg[role=img]')",
      );
      await capture("raw-wave-1366");
      await click("有效波形与频谱");
      await until("document.querySelectorAll('main canvas').length>=2");
      await click("加载同批次点位");
      await until(
        "document.querySelectorAll('.measurement-live-grid canvas').length>=5",
      );
      await js(
        "document.querySelector('.measurement-live-grid').scrollIntoView({block:'start'})",
      );
      await capture("multi-point-1366");
      await click("P5");
      await until("document.querySelectorAll('.measurement-event-list button').length===1");
      await js("document.querySelector('.measurement-event-list button').click()");
      await until("document.querySelector('.measurement-event-detail')?.textContent.includes('800')");
      await js("document.querySelector('.measurement-charts').scrollIntoView({block:'start'})");
      win.setContentSize(1440,1000);
      await capture("waveform-alert-1440");
      win.setContentSize(1366,768);
      await click("P2");
      await until("document.querySelector('main').textContent.includes('未检出符合当前规则')");
      assert.equal(await js("document.querySelectorAll('.measurement-event-list button').length"),0);
    });
    await check("风机概要、3×5矩阵、缺失为未测量，非健康分数", async () => {
      await click("健康监测");
      await until(
        "document.querySelector('.measurement-turbines')?.textContent.includes('QA-WT01')",
      );
      assert.ok(
        await js(
          "document.querySelector('.measurement-turbines').textContent.includes('待积累参考')",
        ),
      );
      assert.ok(
        await js(
          "document.querySelector('.measurement-turbines').textContent.includes('未测量')",
        ),
      );
      assert.equal(await js("document.querySelectorAll('main h1').length"), 1);
      assert.equal(
        await js(
          "document.querySelector('main').textContent.includes('按原始采集记录查看')",
        ),
        false,
      );
      win.setContentSize(1440,1000);
      await capture("health-overview-1440");
      win.setContentSize(1366,768);
      await capture("health-1366");
      await click("查看风机 QA-WT01");
      await until(
        "document.querySelector('main').textContent.includes('频率偏移')",
      );
      await capture("health-matrix-1366");
      await click("全部风机");
    });
    await check("对象维护、工况、模态、报告页面与1024宽度", async () => {
      for (const label of ["模态识别", "风场数据集", "报告导出", "系统管理"]) {
        await click(label);
        await new Promise((r) => setTimeout(r, 500));
        if (label === "系统管理") await click("测量对象与批次");
        await until("!document.querySelector('.measurement-loading')");
        await capture(label);
      }
      win.setContentSize(1024, 850);
      await click("健康监测");
      await until(
        "document.querySelector('.measurement-turbines')?.textContent.includes('QA-WT01')",
      );
      assert.ok(await js("document.documentElement.scrollWidth<=innerWidth+2"));
      await capture("health-1024");
    });
    await login("viewer");
    await check("只读界面不能分析或修改预警规则",async()=>{
      await until("document.querySelector('main').textContent.includes('有效波形与频谱')");
      assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='导入测量数据').disabled"),true);
      await click("健康监测");
      await until("!!document.querySelector('.turbine-overview-card')");
      assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='预警规则').disabled"),true);
    });
    await login("empty");
    await check("空课题组无业务样例、未关联说明和加载状态", async () => {
      await until(
        "document.querySelector('main').textContent.includes('还没有可分析的测量记录')",
      );
      assert.ok(
        !(await js(
          "document.querySelector('main').textContent.includes('QA实测流程')",
        )),
      );
      await capture("empty-rotation");
      await click("健康监测");
      await until(
        "document.querySelector('main').textContent.includes('从一台风机开始')",
      );
      assert.equal(await js("document.querySelectorAll('main h1').length"), 1);
      await capture("empty-health");
    });
  } catch (e) {
    failure = e;
    console.error(e);
    if (win)
      try {
        await capture("failure");
      } catch {}
  } finally {
    if (win) win.destroy();
    if (db) {
      for (const a of accounts) {
        await db.execute("DELETE FROM sessions WHERE user_id=?", [a.id]);
      }
      for (const t of [tenant, emptyTenant]) {
        await db.execute("DELETE FROM audit_logs WHERE tenant=?", [t]);
        await db.execute("DELETE FROM records WHERE tenant=?", [t]);
      }
      for (const id of users)
        await db.execute("DELETE FROM users WHERE id=?", [id]);
      await db.end();
    }
    for (const a of accounts) {
      const hash = createHash("sha256")
        .update(a.tenant + "\0" + a.id)
        .digest("hex");
      fs.rmSync(path.join(root, ".data/web-rotation", hash), {
        recursive: true,
        force: true,
      });
    }
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify({ tests, error: failure?.message || null }, null, 2),
    );
    clearTimeout(watchdog);
    app.exit(failure ? 1 : 0);
  }
});
