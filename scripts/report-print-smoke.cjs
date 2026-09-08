// Verify the product's actual print CSS using Electron's Chromium print engine.
// All API records and the browser profile belong only to this test.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
process.loadEnvFile(path.join(root, "apps/web/.env.local"));
const out = path.join(root, "artifacts/report-print");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile"));
const origin = "http://127.0.0.1:3210";
const created = [];
let token;
async function api(p, method = "GET", data) {
  const res = await fetch(origin + "/api/v1/" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const value = await res.json();
  if (!res.ok) throw Error(`${p}: ${res.status} ${value.error}`);
  return value;
}
app.whenReady().then(async () => {
  let failed;
  const timer = setTimeout(() => { console.error("Print test timed out"); app.exit(1); }, 45000);
  try {
    token = (await api("session", "POST", { username: "admin", password: process.env.BOOTSTRAP_PASSWORD })).token;
    const task = await api("records/tasks", "POST", { name: "PDF 验收任务 " + Date.now(), object: "QA 测试叶片", turbine: "QA-PDF-01", point: "P3", direction: "径向", rpm: 15, blades: 3, sampleRate: 100, duration: 3, range: 10, source: "demo", samples: Array.from({ length: 300 }, (_, i) => Math.sin(i / 12)) });
    created.push(["tasks", task.id]);
    const title = "报告打印验收 " + Date.now();
    const report = await api("records/reports", "POST", { name: title, taskId: task.id, organization: "QA 报告单位", reportNumber: "PRINT-QA-001", sections: ["对象信息", "采集参数", "原始波形", "降噪与截取", "FFT 频谱", "包络与时频", "模态参数", "损伤识别", "结论与建议"], conclusion: "打印验收结论。此报告仅用于验证业务系统的版式和数据引用，不构成实际检测结论。", source: "demo" });
    created.push(["reports", report.id]);
    const win = new BrowserWindow({ show: false, width: 1484, height: 958, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.webContents.session.cookies.set({ url: origin, name: "blade_session", value: token, httpOnly: true, sameSite: "strict" });
    await win.loadURL(origin + "/#report");
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const start = Date.now();
    let loaded = false;
    while (Date.now() - start < 10000) {
      loaded = await js(`(() => { const row = [...document.querySelectorAll('tr')].find(r => r.textContent.includes(${JSON.stringify(title)})); const button = row && [...row.querySelectorAll('button')].find(b => b.textContent === '加载'); if (!button) return false; button.click(); return true; })()`);
      if (loaded) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(loaded, "保存报告必须可以从列表加载");
    const ready = Date.now();
    while (Date.now() - ready < 5000 && !(await js("document.querySelector('#report-print h1')?.textContent === " + JSON.stringify(title)))) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await js("document.querySelector('#report-print h1')?.textContent"), title);
    assert.equal(await js("document.querySelectorAll('#report-print section').length"), 9);
    assert.equal(await js("document.querySelectorAll('#report-print canvas').length"), 1);
    await js("document.fonts.ready.then(() => true)");
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    fs.writeFileSync(path.join(out, "report.pdf"), pdf);
    fs.writeFileSync(path.join(out, "screen.png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ time: new Date().toISOString(), reportId: report.id, sections: 9, waveformCharts: 1, title, printEngine: process.versions.chrome, status: "printed; visual and PDF text review still required" }, null, 2));
    console.log("PASS 实际报告页面的九个章节、任务波形与 Chromium A4 PDF 输出");
  } catch (error) { failed = error; console.error(error.message); }
  finally {
    for (const [kind, id] of created.reverse()) await api(`records/${kind}/${id}`, "DELETE").catch((error) => { failed ||= error; console.error("QA cleanup: " + error.message); });
    if (token) await api("session", "DELETE").catch(() => {});
    clearTimeout(timer);
    app.exit(failed ? 1 : 0);
  }
});
