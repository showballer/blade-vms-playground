'use strict';
// Isolated local QA account. Real CSVs are read-only; all imported QA rows are removed.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const mysql = require('mysql2/promise'), { randomBytes, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/wind-import-20261028');
const folder = path.resolve(process.argv[2] || path.join(root, '../风场状态数据'));
process.loadEnvFile(path.join(root, 'apps/web/.env.local'));
assert.equal(process.env.DB_NAME, 'blade_vms_playground');
const origin = 'http://127.0.0.1:3210', tenant = 'qa_wind_import_' + Date.now();
const username = tenant, password = randomBytes(20).toString('base64url');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
app.setPath('userData', profile); app.on('window-all-closed', () => {});
let win, db, user, token, failure;
const checks = [];
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('UI timeout: ' + code);
}
async function request(resource, method = 'GET', body, authToken = token) {
  const r = await fetch(origin + '/api/v1/' + resource, { method, headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
async function api(resource, method, body, authToken) {
  const r = await request(resource, method, body, authToken);
  if (r.status >= 400) throw Error(`${resource}: ${r.status} ${r.data.error}`);
  return r.data;
}
async function click(text) {
  await until(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();return true;})()`);
}
async function setValue(label, value, select = false) {
  await js(`(()=>{const e=[...document.querySelectorAll('${select ? 'select' : 'input'}')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Field missing');Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}));})()`);
}
async function screenshot(name) {
  await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('QA timeout'); app.exit(1); }, 240000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    const admin = await api('session', 'POST', { username: 'admin', password: process.env.BOOTSTRAP_PASSWORD }, '');
    user = await api('users', 'POST', { username, password, name: '风场文件兼容性验证', role: 'analyst', tenant }, admin.token);
    token = (await api('session', 'POST', { username, password }, '')).token;
    const farm = (await api('objects', 'POST', { kind: 'farm', code: 'WIND-QA', name: '风场文件验证', parentId: null })).object;
    await api('objects', 'POST', { kind: 'turbine', code: 'R018', name: 'R018', parentId: farm.id });
    win = new BrowserWindow({ show: false, width: 1500, height: 1100, useContentSize: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await win.loadURL(origin);
    await until("!!document.querySelector('.login-card')");
    await setValue('账号', username); await setValue('密码', password); await click('登录');
    await until("!!document.querySelector('nav.sidebar')"); await click('风场数据集');
    await until("!!document.querySelector('[aria-label=风场数据文件]') && !document.querySelector('[aria-label=风场数据文件]').disabled");
    await setValue('风场', farm.id, true);
    win.webContents.debugger.attach('1.3');
    const { root: documentRoot } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '[aria-label=风场数据文件]' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: fs.readdirSync(folder).filter(file => file.endsWith('.csv')).map(file => path.join(folder, file)) });
    win.webContents.debugger.detach();
    await until("document.body.innerText.includes('已读取文件。请核对指标单位')");
    assert(await js("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认单位与时区并导入').disabled"));
    const summary = await js("document.querySelector('.measurement-workspace').innerText");
    for (const text of ['R018_当前风速.csv', 'R018_轮毂转速.csv', '183,600', '151,200', '10,800', '舱外温度']) assert(summary.includes(text), text);
    await screenshot('wind-preview-unit-confirmation');
    for (const [label, value] of [['风速原始单位', 'm/s'], ['主轴转速原始单位', 'rpm'], ['发电机有功功率原始单位', 'kW'], ['舱外温度原始单位', 'C']]) await setValue(label, value, true);
    await screenshot('wind-preview-ready');
    await click('确认单位与时区并导入');
    await until("document.body.innerText.includes('已保存 186,000 个风机时间点')");
    const datasets = (await api('wind-datasets')).datasets;
    assert.equal(datasets.length, 1); assert.equal(datasets[0].rowCount, 186000); assert.equal(datasets[0].matchedRowCount, 10800); assert(!('rows' in datasets[0]));
    assert.equal(datasets[0].metricCounts.temperatureC, 183600);
    assert.equal(datasets[0].sources.length, 4);
    checks.push({ realFiles: true, rows: 186000, completeWindAndRpmRows: 10800, explicitUnitsRequired: true, lightweightListing: true, metadata: datasets[0] });
    await screenshot('wind-imported-1500');
    win.setContentSize(1024, 900);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const overflow = await js('document.documentElement.scrollWidth > window.innerWidth + 2');
    assert.equal(overflow, false); await screenshot('wind-imported-1024');
    const duplicate = await request('wind-datasets', 'POST', { name: 'duplicate', farmId: farm.id, rows: [{ time: '2025-12-23T01:10:00Z', turbineCode: 'R018', rpm: 6.94 }] });
    assert.equal(duplicate.status, 409);
    const complement = await request('wind-datasets', 'POST', { name: 'complement', farmId: farm.id, rows: [{ time: '2025-12-23T01:10:00Z', turbineCode: 'R018', windDirection: 45 }] });
    assert.equal(complement.status, 200);
    checks.push({ duplicateMetricRejected: true, complementaryMetricAccepted: true, responsive1024: true });
    console.log('PASS wind UI and HTTP/DB: actual four files, unit confirmation, 186000 rows, 10800 complete rows, bounded listing, duplicate guard, complementary import, responsive screenshots');
  } catch (error) {
    failure = error; console.error(error.message);
    if (win) await screenshot('wind-failed').catch(() => {});
  } finally {
    if (db) {
      for (const table of ['records', 'audit_logs', 'backups']) await db.execute(`DELETE FROM ${table} WHERE tenant=?`, [tenant]).catch(() => {});
      if (user?.id) {
        await db.execute('DELETE FROM sessions WHERE user_id=?', [user.id]);
        await db.execute('DELETE FROM audit_logs WHERE actor_id=? OR target=?', [user.id, user.id]);
        await db.execute('DELETE FROM users WHERE id=? AND tenant=?', [user.id, tenant]);
        const key = createHash('sha256').update(`${tenant}\0${user.id}`).digest('hex');
        fs.rmSync(path.join(process.env.BLADE_ANALYSIS_DATA_DIR || path.join(root, '.data/web-rotation'), key), { recursive: true, force: true });
      }
      await db.end();
    }
    fs.writeFileSync(path.join(output, 'ui-validation.json'), JSON.stringify({ passed: !failure, unitAssumptionForQA: { windSpeed: 'm/s', rpm: 'rpm', powerKw: 'kW', temperatureC: 'C', timezone: '+08:00' }, userDataChanged: false, checks, error: failure?.message }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(failure ? 1 : 0);
  }
});
