// Runs the real Electron main/preload/bundled renderer with an isolated test profile.
const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
const phase = process.env.BLADE_SMOKE_PHASE || "create";
const artifact = path.join(root, "artifacts/desktop-smoke");
fs.mkdirSync(artifact, { recursive: true });
app.setPath("userData", path.join(artifact, "profile"));
delete process.env.BLADE_DEV_URL;
const results = [];
const watchdog = setTimeout(() => {
  console.error("Electron smoke timed out");
  app.exit(1);
}, 45000);
async function check(name, fn) {
  await fn();
  results.push({ name, result: "pass" });
  console.log("PASS " + name);
}
app.on("browser-window-created", (_event, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    const js = (code) => wc.executeJavaScript(code, true);
    const ipc = (fn, args) => js(`window.blade.${fn}(${JSON.stringify(args)})`);
    try {
      await check("离线打包资源通过 file:// 加载", async () =>
        assert.ok(wc.getURL().startsWith("file://")),
      );
      await check("渲染进程开启隔离和沙盒", async () => {
        const p = wc.getLastWebPreferences();
        assert.equal(p.nodeIntegration, false);
        assert.equal(p.contextIsolation, true);
        assert.equal(p.sandbox, true);
        assert.equal(await js("typeof window.require"), "undefined");
        assert.equal(await js("typeof window.blade.request"), "function");
      });
      if (phase === "create") {
        await check("原生桥接登录且不向渲染进程暴露令牌", async () => {
          const res = await ipc("request", {
            path: "session",
            method: "POST",
            body: {
              username: "admin",
              password: process.env.BOOTSTRAP_PASSWORD,
            },
          });
          assert.equal(res.status, 200);
          assert.equal(res.data.token, undefined);
        });
        await check("原生桥接读取业务数据", async () =>
          assert.ok(
            (await ipc("request", { path: "bootstrap", method: "GET" })).data
              .tasks.length >= 3,
          ),
        );
        await check("受限桥接拒绝路径穿越", async () =>
          assert.equal(
            (
              await ipc("request", {
                path: "records/../../health",
                method: "GET",
              })
            ).status,
            503,
          ),
        );
        await check("原生保存对话框导出 JSON", async () => {
          const output = path.join(artifact, "native-export.json");
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: output,
          });
          const res = await ipc("download", "export/tasks/task-a1?format=json");
          assert.equal(res.path, output);
          assert.equal(
            JSON.parse(fs.readFileSync(output, "utf8"))[0].id,
            "task-a1",
          );
        });
        await check("取消原生保存不返回成功文件路径", async () => {
          dialog.showSaveDialog = async () => ({ canceled: true });
          const res = await ipc("download", "export/tasks/task-a1?format=json");
          assert.equal(res.canceled, true);
          assert.equal(res.path, undefined);
        });
        await ipc("request", { path: "session", method: "DELETE" });
        await check("无法连接服务时返回明确错误", async () => {
          await ipc("settings", "http://127.0.0.1:1");
          assert.equal(
            (await ipc("request", { path: "bootstrap", method: "GET" })).status,
            503,
          );
        });
        await check("离线任务和分析实际写入本机文件", async () => {
          const r = await ipc("offline", {
            path: "records/tasks",
            method: "POST",
            body: {
              name: "Electron QA 离线持久化",
              object: "QA",
              turbine: "QA-01",
              point: "P1",
              rpm: 15,
              blades: 3,
              sampleRate: 100,
              duration: 0.03,
              samples: [1, 2, 3],
              source: "demo",
              environment: "QA 离线元信息",
              testTime: "2026-09-07T01:00:00Z",
              channels: [{ no: 2, type: "velocity", unit: "mm/s" }],
              raw_preserved: false,
            },
          });
          assert.equal(r.status, 201);
          assert.equal(r.data.raw_preserved, true);
          const invalid = await ipc("offline", { path: "records/tasks/" + r.data.id, method: "PUT", body: { channels: [{ no: 0, type: "velocity", unit: "mm/s" }] } });
          assert.equal(invalid.status, 400);
          const restored = await ipc("offline", { path: "records/tasks/" + r.data.id, method: "GET" });
          assert.equal(restored.data.environment, "QA 离线元信息");
          assert.equal(restored.data.channels[0].no, 2);
          fs.writeFileSync(path.join(artifact, "record-id.txt"), r.data.id);
          const a = await ipc("offline", {
            path: "records/analyses",
            method: "POST",
            body: {
              name: "Electron QA 分析",
              taskId: r.data.id,
              type: "fft",
              parameters: { nfft: 4096 },
              source: "demo",
            },
          });
          assert.equal(a.status, 201);
          assert.ok(
            JSON.parse(
              fs.readFileSync(
                path.join(artifact, "profile/blade-offline.json"),
                "utf8",
              ),
            ).tasks.some((t) => t.id === r.data.id),
          );
        });
      } else {
        const id = fs.readFileSync(
          path.join(artifact, "record-id.txt"),
          "utf8",
        );
        await check("冷启动恢复离线任务", async () =>
          assert.deepEqual(
            (
              await ipc("offline", {
                path: "records/tasks/" + id,
                method: "GET",
              })
            ).data.samples,
            [1, 2, 3],
          ),
        );
        await check("离线修改任务并读取", async () => {
          assert.equal(
            (
              await ipc("offline", {
                path: "records/tasks/" + id,
                method: "PUT",
                body: { note: "重启后修改" },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await ipc("offline", {
                path: "records/tasks/" + id,
                method: "GET",
              })
            ).data.note,
            "重启后修改",
          );
        });
      }
      await check("离线不存在记录返回 404", async () => {
        assert.equal((await ipc("offline", { path: "records/tasks/does-not-exist", method: "GET" })).status, 404);
      });
      await check("离线无效参数不会改变已保存任务或磁盘文件", async () => {
        const id = fs.readFileSync(path.join(artifact, "record-id.txt"), "utf8");
        const workspaceFile = path.join(artifact, "profile/blade-offline.json");
        const before = fs.readFileSync(workspaceFile, "utf8");
        for (const body of [{ sampleRate: 0 }, { blades: 1.5 }, { rpm: -1 }, { name: " " }, { samples: [1, "invalid"] }]) {
          const res = await ipc("offline", { path: "records/tasks/" + id, method: "PUT", body });
          assert.equal(res.status, 400);
        }
        assert.equal(fs.readFileSync(workspaceFile, "utf8"), before);
        assert.deepEqual((await ipc("offline", { path: "records/tasks/" + id, method: "GET" })).data.samples, [1, 2, 3]);
      });
      await check("离线分析不能引用不存在任务", async () => {
        assert.equal((await ipc("offline", { path: "records/analyses", method: "POST", body: { name: "invalid", taskId: "missing" } })).status, 400);
      });
      await check("离线不支持的方法和层级拒绝执行", async () => {
        assert.equal((await ipc("offline", { path: "records/tasks", method: "PATCH" })).status, 405);
        assert.equal((await ipc("offline", { path: "records/tasks/missing/extra", method: "GET" })).status, 403);
      });
      // Wait on actual rendered UI, not an arbitrary startup sleep.
      await check("离线入口可进入完整桌面页面", async () => {
        const started = Date.now();
        while (Date.now() - started < 12000) {
          const found = await js(
            `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === '离线演示工作区'); if (b) {b.click(); return true;} return false; })()`,
          );
          if (found) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const start = Date.now();
        while (
          Date.now() - start < 5000 &&
          !(await js("!!document.querySelector('nav.sidebar')"))
        )
          await new Promise((r) => setTimeout(r, 100));
        assert.ok(
          await js("document.body.innerText.includes('历史与批量管理')"),
        );
        assert.ok(await js("document.body.innerText.includes('离线演示')"));
        assert.equal(
          await js("document.querySelectorAll('.workspace canvas').length"),
          1,
        );
      });
      await check("桌面窗口最大化和还原桥接", async () => {
        const before = win.isMaximized();
        await js("window.blade.windowControl('maximize')");
        await new Promise((r) => setTimeout(r, 300));
        assert.notEqual(win.isMaximized(), before);
        await js("window.blade.windowControl('maximize')");
      });
      fs.writeFileSync(
        path.join(artifact, `electron-${phase}.png`),
        (await wc.capturePage()).toPNG(),
      );
      await ipc("settings", "http://127.0.0.1:3210");
      fs.writeFileSync(
        path.join(artifact, `results-${phase}.json`),
        JSON.stringify(
          { platform: process.platform, phase, tests: results },
          null,
          2,
        ),
      );
      clearTimeout(watchdog);
      app.exit(0);
    } catch (e) {
      console.error(e.message);
      fs.writeFileSync(
        path.join(artifact, `results-${phase}.json`),
        JSON.stringify(
          {
            platform: process.platform,
            phase,
            tests: results,
            error: e.message,
          },
          null,
          2,
        ),
      );
      clearTimeout(watchdog);
      app.exit(1);
    }
  });
});
require(path.join(root, "apps/desktop/electron/main.cjs"));
