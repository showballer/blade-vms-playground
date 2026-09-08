import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import JSZip from "jszip";
import { runBackupOnce } from "./backup-worker.mjs";
const base = "http://127.0.0.1:3210/api/v1/",
  tag = "qa_" + Date.now(),
  pass = randomBytes(14).toString("base64url"),
  results = [],
  userIds = [];
const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
async function call(path, method = "GET", data, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: res.status, body, headers: res.headers, raw };
}
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, result: "pass" });
    console.log("PASS " + name);
  } catch (e) {
    results.push({ name, result: "fail", message: e.message });
    throw e;
  }
}
const task = {
  name: tag + " task",
  object: "QA 测试对象",
  turbine: "QA-01",
  point: "P1 叶根",
  direction: "径向",
  rpm: 15,
  blades: 3,
  sampleRate: 25600,
  duration: 3,
  status: "本地",
  source: "demo",
  samples: [0, 1.5, -2.25, 0.5],
  testTime: "2026-09-07T01:30:00Z",
  environment: "QA 风速 8m/s，温度 20℃",
  faultType: "未标注",
  channels: [{ no: 2, type: "velocity", unit: "mm/s" }],
  raw_preserved: false,
};
try {
  await check("健康检查和数据库连通", async () =>
    assert.equal((await call("health")).status, 200),
  );
  await check("未登录拒绝读取业务", async () =>
    assert.equal((await call("bootstrap")).status, 401),
  );
  await check("错误密码拒绝登录", async () =>
    assert.equal(
      (
        await call("session", "POST", {
          username: "admin",
          password: "invalid-for-qa",
        })
      ).status,
      401,
    ),
  );
  const login = await call("session", "POST", {
    username: "admin",
    password: process.env.BOOTSTRAP_PASSWORD,
  });
  assert.equal(login.status, 200);
  const root = login.body.token;
  await check("会话 cookie 为 HttpOnly", async () =>
    assert.ok(login.headers.get("set-cookie").includes("HttpOnly")),
  );
  const tokens = {};
  for (const role of ["admin", "analyst", "operator", "viewer"]) {
    const username = tag + "_" + role;
    const r = await call(
      "users",
      "POST",
      { username, name: "QA " + role, role, tenant: tag, password: pass },
      root,
    );
    assert.equal(r.status, 201);
    userIds.push(r.body.id);
    tokens[role] = (
      await call("session", "POST", { username, password: pass })
    ).body.token;
  }
  await check("匿名来源跨站写入被拒绝", async () => {
    const r = await fetch(base + "records/tasks", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + root,
        Origin: "https://untrusted.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(task),
    });
    assert.equal(r.status, 403);
  });
  await check("访客不能新增任务", async () =>
    assert.equal(
      (await call("records/tasks", "POST", task, tokens.viewer)).status,
      403,
    ),
  );
  await check("操作员不能修改阈值", async () =>
    assert.equal(
      (
        await call(
          "records/settings/thresholds",
          "PUT",
          { name: "阈值", rms: 99 },
          tokens.operator,
        )
      ).status,
      403,
    ),
  );
  await check("分析员不能管理用户", async () =>
    assert.equal(
      (await call("users", "GET", undefined, tokens.analyst)).status,
      403,
    ),
  );
  let id;
  await check("无效密码不会部分修改用户资料", async () => {
    const response = await call(
      "users/" + userIds[1],
      "PUT",
      {
        name: "不得保存",
        role: "analyst",
        tenant: tag,
        active: true,
        password: "short",
      },
      root,
    );
    assert.equal(response.status, 400);
    const [users] = await db.execute("SELECT name FROM users WHERE id=?", [
      userIds[1],
    ]);
    assert.equal(users[0].name, "QA analyst");
  });
  await check("服务端拒绝无效预警比例", async () =>
    assert.equal(
      (
        await call(
          "records/settings/thresholds",
          "PUT",
          { warningRatio: 1.5 },
          root,
        )
      ).status,
      400,
    ),
  );
  await check("访客不能绕过权限导出模型配置", async () =>
    assert.equal(
      (await call("export/models?format=json", "GET", undefined, tokens.viewer))
        .status,
      403,
    ),
  );
  await check("操作员创建任务真实落库", async () => {
    const r = await call("records/tasks", "POST", task, tokens.operator);
    assert.equal(r.status, 201);
    id = r.body.id;
    const [rows] = await db.execute("SELECT body FROM records WHERE id=?", [
      id,
    ]);
    assert.equal(rows.length, 1);
  });
  await check("同课题组访客可以读取任务", async () =>
    assert.equal(
      (await call("records/tasks/" + id, "GET", undefined, tokens.viewer)).body
        .name,
      task.name,
    ),
  );
  await check("任务完整元信息真实保存，原始保留状态不信任客户端", async () => {
    const row = (await call("records/tasks/" + id, "GET", undefined, tokens.viewer)).body;
    for (const key of ["testTime", "environment", "faultType", "channels"]) assert.deepEqual(row[key], task[key]);
    assert.equal(row.raw_preserved, true);
  });
  await check("无效通道和测试时间不能覆盖有效元信息", async () => {
    for (const patch of [{ channels: [task.channels[0], task.channels[0]] }, { testTime: "bad-date" }, { channels: [{ no: 1, type: "velocity", unit: "" }] }, { blades: 1.5 }, { samples: null }])
      assert.equal((await call("records/tasks/" + id, "PUT", patch, tokens.operator)).status, 400);
    const row = (await call("records/tasks/" + id, "GET", undefined, tokens.viewer)).body;
    assert.deepEqual(row.channels, task.channels); assert.equal(row.testTime, task.testTime);
  });
  await check("初始化接口不泄露无权读取的模型和系统配置", async () => {
    for (const role of ["viewer", "operator", "analyst"]) {
      const res = await call("bootstrap", "GET", undefined, tokens[role]);
      assert.equal(res.status, 200); assert.deepEqual(res.body.models, []); assert.deepEqual(res.body.settings, []);
    }
  });
  await check("操作员仅可列出、读取和导出本人任务及关联结果", async () => {
    const other = await call("records/tasks", "POST", { ...task, name: tag + " 他人任务" }, tokens.analyst);
    assert.equal(other.status, 201);
    const otherId = other.body.id;
    const analysis = await call("records/analyses", "POST", { name: tag + " 他人分析", taskId: otherId, type: "fft", source: "demo" }, tokens.analyst);
    assert.equal(analysis.status, 201);
    const result = await call("records/reports", "POST", { name: tag + " 他人报告", taskId: otherId, sections: ["对象信息"] }, tokens.analyst);
    assert.equal(result.status, 201);
    const view = (await call("bootstrap", "GET", undefined, tokens.operator)).body;
    assert.ok(view.tasks.some((r) => r.id === id)); assert.ok(!view.tasks.some((r) => r.id === otherId));
    assert.ok(!view.analyses.some((r) => r.id === analysis.body.id)); assert.ok(!view.reports.some((r) => r.id === result.body.id));
    for (const path of ["records/tasks/" + otherId, "export/tasks/" + otherId + "?format=json", "records/analyses/" + analysis.body.id, "export/reports/" + result.body.id + "?format=docx"]) assert.equal((await call(path, "GET", undefined, tokens.operator)).status, 404);
    for (const method of ["PUT", "DELETE"]) assert.equal((await call("records/tasks/" + otherId, method, { name: "不应覆盖" }, tokens.operator)).status, 404);
    assert.equal((await call("records/analyses", "POST", { name: "跨任务分析", taskId: otherId, type: "fft" }, tokens.operator)).status, 404);
    assert.equal((await call("records/analyses", "POST", { name: "跨课题组分析", taskId: "task-a1", type: "fft" }, tokens.analyst)).status, 404);
  });
  await check("不同课题组不能读取初始任务", async () =>
    assert.equal(
      (await call("records/tasks/task-a1", "GET", undefined, tokens.viewer))
        .status,
      404,
    ),
  );
  await check("不同课题组不能导出初始任务", async () =>
    assert.equal(
      (
        await call(
          "export/tasks/task-a1?format=json",
          "GET",
          undefined,
          tokens.viewer,
        )
      ).status,
      404,
    ),
  );
  await check("访客不能修改任务", async () =>
    assert.equal(
      (
        await call(
          "records/tasks/" + id,
          "PUT",
          { name: "不应保存" },
          tokens.viewer,
        )
      ).status,
      403,
    ),
  );
  await check("无效采样参数拒绝", async () =>
    assert.equal(
      (
        await call(
          "records/tasks/" + id,
          "PUT",
          { sampleRate: -1 },
          tokens.operator,
        )
      ).status,
      400,
    ),
  );
  await check("更新任务并重新读取", async () => {
    assert.equal(
      (
        await call(
          "records/tasks/" + id,
          "PUT",
          { note: "QA 持久化检查" },
          tokens.operator,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("records/tasks/" + id, "GET", undefined, tokens.viewer)).body
        .note,
      "QA 持久化检查",
    );
  });
  await check("分析员保存演示分析", async () =>
    assert.equal(
      (
        await call(
          "records/analyses",
          "POST",
          {
            name: tag + "分析",
            taskId: id,
            type: "fft",
            source: "demo",
            parameters: { nfft: 4096 },
            result: { source: "demo" },
          },
          tokens.analyst,
        )
      ).status,
      201,
    ),
  );
  await check("操作员不能保存模态分析", async () =>
    assert.equal(
      (
        await call(
          "records/analyses",
          "POST",
          { name: "不应保存", taskId: id, type: "modal" },
          tokens.operator,
        )
      ).status,
      403,
    ),
  );
  await check("操作员可保存和修改本人任务的基础分析", async () => {
    const r = await call("records/analyses", "POST", { name: tag + " 本人 FFT", taskId: id, type: "fft", source: "demo" }, tokens.operator);
    assert.equal(r.status, 201);
    assert.equal((await call("records/analyses/" + r.body.id, "PUT", { parameters: { nfft: 1024 } }, tokens.operator)).status, 200);
    assert.equal((await call("records/analyses/" + r.body.id, "PUT", { type: "damage" }, tokens.operator)).status, 403);
  });
  const syncBundle = { clientId: "client-" + tag, localId: "local-task", revision: randomBytes(32).toString("hex"), task: { ...task, name: tag + " 离线任务" }, analyses: [{ name: tag + " 离线 FFT", taskId: "local-task", type: "fft", parameters: { nfft: 1024 }, source: "demo" }] };
  let syncResult;
  await check("离线回传并发重试只创建一组任务和关联分析", async () => {
    const attempts = await Promise.all(Array.from({ length: 3 }, () => call("sync/tasks", "POST", syncBundle, tokens.operator)));
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 200, 201]);
    syncResult = attempts[0].body;
    assert.equal(new Set(attempts.map((r) => r.body.taskId)).size, 1);
    assert.equal(syncResult.analysisIds.length, 1);
    const row = (await call("records/tasks/" + syncResult.taskId, "GET", undefined, tokens.operator)).body;
    assert.deepEqual(row.samples, task.samples); assert.equal(row.syncOrigin.localId, syncBundle.localId);
    const analysis = (await call("records/analyses/" + syncResult.analysisIds[0], "GET", undefined, tokens.operator)).body;
    assert.equal(analysis.taskId, syncResult.taskId);
    const [logs] = await db.execute("SELECT id FROM audit_logs WHERE tenant=? AND action='离线任务回传'", [tag]); assert.equal(logs.length, 1);
  });
  await check("回传重试不覆盖服务器后续修改，冲突版本明确拒绝", async () => {
    await call("records/tasks/" + syncResult.taskId, "PUT", { note: "服务端后续修改" }, tokens.operator);
    assert.equal((await call("sync/tasks", "POST", syncBundle, tokens.operator)).status, 200);
    const row = (await call("records/tasks/" + syncResult.taskId, "GET", undefined, tokens.operator)).body;
    assert.equal(row.note, "服务端后续修改"); assert.equal(row.syncOrigin.revision, syncBundle.revision);
    assert.equal((await call("sync/tasks", "POST", { ...syncBundle, task: { ...syncBundle.task, note: "同版本不同内容" } }, tokens.operator)).status, 409);
  });
  await check("回传越权或错误关联不会写入部分任务", async () => {
    assert.equal((await call("sync/tasks", "POST", syncBundle, tokens.viewer)).status, 403);
    for (const analysis of [{ ...syncBundle.analyses[0], type: "damage" }, { ...syncBundle.analyses[0], taskId: "foreign" }]) {
      const before = (await call("records/tasks", "GET", undefined, tokens.operator)).body.length;
      const res = await call("sync/tasks", "POST", { ...syncBundle, revision: randomBytes(32).toString("hex"), analyses: [analysis] }, tokens.operator);
      assert.ok([400, 403].includes(res.status));
      assert.equal((await call("records/tasks", "GET", undefined, tokens.operator)).body.length, before);
    }
  });
  await check("新的本地修订另建记录，已删除回传记录不会静默复活", async () => {
    const changed = { ...syncBundle, revision: randomBytes(32).toString("hex"), task: { ...syncBundle.task, note: "本地新修订" } };
    const res = await call("sync/tasks", "POST", changed, tokens.operator); assert.equal(res.status, 201); assert.notEqual(res.body.taskId, syncResult.taskId);
    await call("records/tasks/" + res.body.taskId, "DELETE", undefined, tokens.operator);
    assert.equal((await call("sync/tasks", "POST", changed, tokens.operator)).status, 409);
  });
  let report;
  const qaLogo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await check("报告保存", async () => {
    const r = await call(
      "records/reports",
      "POST",
      {
        name: tag + "报告",
        taskId: id,
        sections: [
          "对象信息",
          "采集参数",
          "原始波形",
          "FFT 频谱",
          "结论与建议",
        ],
        conclusion: "QA 报告",
        source: "demo",
        organization: "QA 报告单位",
        reportNumber: "QA-RPT-001",
        logoData: qaLogo,
        logoAspect: 1,
      },
      tokens.analyst,
    );
    assert.equal(r.status, 201);
    report = r.body.id;
  });
  await check("报告保存关联任务和分析快照", async () => {
    const r = await call(
      "records/reports/" + report,
      "GET",
      undefined,
      tokens.analyst,
    );
    assert.equal(r.body.taskSnapshot.object, "QA 测试对象");
    assert.deepEqual(r.body.taskSnapshot.samples, task.samples);
    // Both analysts and operators can now save FFT records. Verify both snapshots;
    // never assume insertion order for records created within the same DB timestamp.
    assert.equal(r.body.analysisSnapshots.length, 2);
    assert.ok(r.body.analysisSnapshots.every((a) => a.taskId === id));
    assert.equal(r.body.analysisSnapshots.find((a) => a.name === tag + "分析").parameters.nfft, 4096);
    assert.equal(r.body.analysisSnapshots.find((a) => a.name === tag + " 本人 FFT").parameters.nfft, 1024);
  });
  await check("报告抬头编号与 Logo 配置真实保存", async () => {
    const r = await call("records/reports/" + report, "GET", undefined, tokens.analyst);
    assert.equal(r.body.organization, "QA 报告单位");
    assert.equal(r.body.reportNumber, "QA-RPT-001");
    assert.equal(r.body.logoData, qaLogo);
    const t = await call("records/templates", "POST", { name: tag + "模板", sections: ["对象信息"], organization: "QA 报告单位", reportNumber: "QA-TPL", logoData: qaLogo, logoAspect: 1 }, tokens.analyst);
    assert.equal(t.status, 201);
    assert.equal(t.body.logoData, qaLogo);
  });
  await check("报告 Logo 拒绝外部地址和伪装图片", async () => {
    for (const logoData of ["https://example.invalid/logo.png", "data:image/png;base64,YmFk"]) {
      assert.equal((await call("records/reports/" + report, "PUT", { logoData, logoAspect: 1 }, tokens.analyst)).status, 400);
    }
  });
  await check("报告不能引用其他课题组任务", async () =>
    assert.equal(
      (
        await call(
          "records/reports",
          "POST",
          { name: "跨组不可见", taskId: "task-a1", sections: ["对象信息"] },
          tokens.analyst,
        )
      ).status,
      404,
    ),
  );
  await check("未知导出格式明确拒绝", async () =>
    assert.equal(
      (
        await call(
          "export/tasks/" + id + "?format=unknown",
          "GET",
          undefined,
          tokens.viewer,
        )
      ).status,
      400,
    ),
  );
  await check("MAT 导出含原始时间幅值矩阵", async () => {
    const r = await fetch(base + "export/tasks/" + id + "?format=mat", {
      headers: { Authorization: "Bearer " + tokens.viewer },
    });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.readInt32LE(0), 0);
    assert.equal(bytes.readInt32LE(4), 4);
    assert.equal(bytes.readInt32LE(8), 2);
    const offset = 20 + bytes.readInt32LE(16);
    for (let i = 0; i < 4; i++) {
      assert.equal(bytes.readDoubleLE(offset + i * 8), i / 25600);
      assert.equal(bytes.readDoubleLE(offset + 32 + i * 8), task.samples[i]);
    }
    mkdirSync("artifacts", { recursive: true });
    writeFileSync("artifacts/verified-wave.mat", bytes);
  });
  for (const fmt of ["json", "csv", "txt", "xlsx"])
    await check("导出 " + fmt + " 返回有效文件", async () => {
      const r = await fetch(base + "export/tasks/" + id + "?format=" + fmt, {
        headers: { Authorization: "Bearer " + tokens.viewer },
      });
      assert.equal(r.status, 200);
      assert.ok(r.headers.get("content-disposition").includes("." + fmt));
      const b = Buffer.from(await r.arrayBuffer());
      assert.ok(b.length > 20);
      if (fmt === "xlsx") assert.equal(b.subarray(0, 2).toString(), "PK");
    });
  await check("Word 报告是有效 DOCX 压缩包", async () => {
    const r = await fetch(base + "export/reports/" + report + "?format=docx", {
      headers: { Authorization: "Bearer " + tokens.analyst },
    });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml").async("string");
    for (const text of ["QA 测试对象", "QA-01", "25600", "4096", "QA 报告", "QA 报告单位", "QA-RPT-001"])
      assert.ok(xml.includes(text), "Word missing " + text);
    assert.ok(!xml.includes("[object Object]"));
    assert.ok(Object.keys(zip.files).some((name) => name.startsWith("word/media/") && name.endsWith(".png")));
    assert.equal(Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && name.endsWith(".png")).length, 2, "Word must embed both the configured logo and the saved waveform");
    writeFileSync("artifacts/verified-report.docx", bytes);
  });
  await check("任务修改不改变历史报告快照", async () => {
    await call("records/tasks/" + id, "PUT", { object: "QA 修改后的对象" }, tokens.operator);
    const stored = await call("records/reports/" + report, "GET", undefined, tokens.analyst);
    assert.equal(stored.body.taskSnapshot.object, "QA 测试对象");
    await call("records/tasks/" + id, "PUT", { object: "QA 测试对象" }, tokens.operator);
  });
  let backup;
  await check("独立 QA 课题组备份", async () => {
    const r = await call("backups", "POST", {}, tokens.admin);
    assert.equal(r.status, 201);
    backup = r.body.id;
    assert.ok(r.body.count >= 3);
  });
  await check("恢复必须二次确认", async () =>
    assert.equal(
      (
        await call(
          "backups/restore",
          "POST",
          { id: backup, confirm: "错误" },
          tokens.admin,
        )
      ).status,
      400,
    ),
  );
  await check("业务恢复实际还原 QA 数据", async () => {
    await call(
      "records/tasks/" + id,
      "PUT",
      { note: "备份后修改" },
      tokens.operator,
    );
    assert.equal(
      (
        await call(
          "backups/restore",
          "POST",
          { id: backup, confirm: "恢复业务数据" },
          tokens.admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("records/tasks/" + id, "GET", undefined, tokens.viewer)).body
        .note,
      "QA 持久化检查",
    );
  });
  await check("备份恢复未影响其他课题组任务", async () =>
    assert.equal(
      (await call("records/tasks/task-a1", "GET", undefined, root)).body.name,
      "叶片A-工况1",
    ),
  );
  await check("API 令牌可用且撤销后失效", async () => {
    const r = await call(
      "tokens",
      "POST",
      { name: tag + "访问令牌" },
      tokens.admin,
    );
    assert.equal(r.status, 201);
    assert.equal(
      (await call("bootstrap", "GET", undefined, r.body.token)).status,
      200,
    );
    const list = await call("tokens", "GET", undefined, tokens.admin);
    const t = list.body.find((x) => x.name === tag + "访问令牌");
    await call("tokens/" + t.id, "DELETE", undefined, tokens.admin);
    assert.equal(
      (await call("bootstrap", "GET", undefined, r.body.token)).status,
      401,
    );
  });
  await check("自身管理员不能禁用", async () =>
    assert.equal(
      (
        await call(
          "users/" + userIds[0],
          "PUT",
          { name: "QA admin", role: "admin", tenant: tag, active: false },
          tokens.admin,
        )
      ).status,
      400,
    ),
  );
  await check("业务操作生成审计日志", async () => {
    const r = await call("logs", "GET", undefined, root);
    assert.ok(
      r.body.some((x) => x.action === "恢复业务备份" && x.target === backup),
    );
  });
  await check("自动备份计划真实执行且当日不重复", async () => {
    const r = await call(
      "records/settings",
      "POST",
      { name: "QA 自动备份", enabled: true, hour: 0 },
      tokens.admin,
    );
    assert.equal(r.status, 201);
    const now = new Date();
    const first = await runBackupOnce({ tenant: tag, now });
    assert.equal(first.length, 1);
    assert.equal(first[0].tenant, tag);
    assert.equal((await runBackupOnce({ tenant: tag, now })).length, 0);
    const [records] = await db.execute("SELECT body FROM records WHERE id=?", [
      first[0].id,
    ]);
    const body =
      typeof records[0].body === "string"
        ? JSON.parse(records[0].body)
        : records[0].body;
    assert.ok(body.snapshot.every((r) => r.tenant === tag));
  });
  await check("退出后会话失效", async () => {
    assert.equal(
      (await call("session", "DELETE", undefined, tokens.viewer)).status,
      200,
    );
    assert.equal(
      (await call("bootstrap", "GET", undefined, tokens.viewer)).status,
      401,
    );
  });
  await call("session", "DELETE", undefined, root);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await db.execute("DELETE FROM sync_imports WHERE tenant=?", [tag]);
  await db.execute("DELETE FROM records WHERE tenant=?", [tag]);
  for (const id of userIds)
    await db.execute("DELETE FROM users WHERE id=?", [id]);
  await db.end();
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/api-test-results.json",
    JSON.stringify(
      {
        time: new Date().toISOString(),
        scope: "project-only QA tenant; other schemas untouched",
        tests: results,
      },
      null,
      2,
    ),
  );
  console.log(
    `${results.filter((r) => r.result === "pass").length}/${results.length} checks passed. QA tenant data cleaned; audit preserved.`,
  );
}
