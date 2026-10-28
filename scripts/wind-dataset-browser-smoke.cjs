'use strict';
// Actual local Web UI/API acceptance. Only a dedicated QA tenant is mutated;
// existing wf1/R018 records are read-only and compared before/after by SHA-256.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:3210';
const output = path.join(root, 'artifacts/wind-dataset-browser-20261028');
const arguments_ = process.argv.slice(2);
const standardOnly = arguments_.includes('--standard-only');
const fileArguments = arguments_.filter(value => value !== '--standard-only');
assert.ok(!fileArguments.length || fileArguments.length === 2 && fileArguments[0] === '--standard-csv', 'Optional arguments: --standard-csv /path/to/turbine-minute.csv [--standard-only]');
const standardCsv = fileArguments.length ? path.resolve(fileArguments[1]) : null;
assert.ok(!standardOnly || standardCsv, '--standard-only requires --standard-csv');
process.loadEnvFile(path.join(root, 'apps/web/.env.local'));
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST), 'Local database required.');
assert.equal(process.env.DB_NAME, 'blade_vms_playground');
const tenant = 'qa_wind_browser_' + Date.now();
const password = randomBytes(24).toString('base64url');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-wind-browser-'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', profile); app.on('window-all-closed', () => {});
let db, user, token, adminToken, datasetId, win, failure, realBefore;
const report = { origin, qaTenant: tenant, hardwareTested: false, productionAccessed: false, checks: [], screenshots: [], browserNetwork: [], browserErrors: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function safeError(error) {
  let message = String(error?.message || error);
  for (const secret of [password, token, adminToken, process.env.BOOTSTRAP_PASSWORD, process.env.DB_PASSWORD])
    if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 2000);
}
async function request(resource, method = 'GET', body, auth = token) {
  // Never mutate a real dataset through an administrator session.
  if (auth === adminToken && method !== 'GET') assert.ok(resource === 'users' && method === 'POST' || resource === 'session' && method === 'DELETE');
  const response = await fetch(`${origin}/api/v1/${resource}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  return { status: response.status, data: await response.json() };
}
async function api(resource, method, body, auth) {
  const response = await request(resource, method, body, auth);
  if (response.status >= 400) throw Error(`${resource}: HTTP ${response.status}`);
  return response.data;
}
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await js(code)) return; await sleep(60); }
  throw Error(`UI timeout: ${label}`);
}
async function check(name, fn) {
  if (standardOnly && !name.startsWith('standard ')) return;
  await fn(); report.checks.push(name); console.log(`PASS ${name}`);
}
async function click(label, scope = 'document') {
  await until(`(()=>{const parent=${scope};const e=parent&&[...parent.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true;})()`, `click ${label}`);
}
async function datasetAction(name, label) {
  await until(`(()=>{const row=[...document.querySelectorAll('.measurement-workspace table tbody tr')].find(e=>e.textContent.includes(${JSON.stringify(name)}));const b=row&&[...row.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`, `${label} selected dataset`);
}
async function pageReady(count, first) {
  await until(`(()=>{const panel=document.querySelector('.wind-preview-table[aria-busy="false"]');const rows=panel?.querySelectorAll('tbody tr');return rows?.length===${count}&&rows[0]?.cells[0].textContent.trim()===${JSON.stringify(String(first))};})()`, `page starts ${first}, ${count} rows`);
}
async function closeDialog() {
  await js(`document.querySelector('dialog[open] button[aria-label="关闭弹窗"]').click()`);
  await until(`!document.querySelector('dialog[open]')`, 'closed dialog');
}
async function pageSize(value) {
  await js(`(()=>{const e=document.querySelector('dialog[open] select[aria-label="每页条数"]');if(!e||e.disabled)throw Error('Page size unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function selectValue(label, value) {
  await js(`(()=>{const e=document.querySelector('select[aria-label=${JSON.stringify(label)}]');if(!e||e.disabled)throw Error('Selection unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function screenshot(name) {
  await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  const file = path.join(output, `${name}.png`);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
}
async function browser(auth, readOnly = false) {
  win?.destroy();
  const partition = `wind-dataset-qa-${randomUUID()}`, ses = session.fromPartition(partition);
  await ses.cookies.set({ url: origin, name: 'blade_session', value: auth, path: '/', httpOnly: true, sameSite: 'lax' });
  // The real account window cannot issue data mutations even accidentally.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const local = details.url.startsWith(origin + '/') || details.url.startsWith('ws://127.0.0.1:3210/') || /^(?:devtools:|data:|blob:)/.test(details.url);
    const forbiddenMutation = readOnly && details.url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(details.method);
    if (!local || forbiddenMutation) report.browserNetwork.push({ blocked: true, path: new URL(details.url).pathname, method: details.method });
    callback({ cancel: !local || forbiddenMutation });
  });
  ses.webRequest.onCompleted(details => { if (details.url.includes('/api/')) report.browserNetwork.push({ path: new URL(details.url).pathname, status: details.statusCode }); });
  ses.webRequest.onErrorOccurred(details => report.browserNetwork.push({ path: new URL(details.url).pathname, error: details.error }));
  win = new BrowserWindow({ show: false, width: 1500, height: 1050, useContentSize: true,
    webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') report.browserErrors.push(safeError(event.message)); });
  await win.loadURL(origin + '/#wind');
  await until(`document.body.innerText.includes('已保存数据集')&&!document.querySelector('.measurement-loading')`, 'saved datasets screen');
}
async function realSnapshot() {
  const [rows] = await db.execute("SELECT id,SHA2(CAST(body AS CHAR),256) AS sha256 FROM records WHERE kind='wind_datasets' AND tenant='新能源A组' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.farmId')) IN (SELECT f.id FROM records f WHERE f.kind='measurement_objects' AND f.tenant='新能源A组' AND JSON_UNQUOTE(JSON_EXTRACT(f.body,'$.kind'))='farm' AND JSON_UNQUOTE(JSON_EXTRACT(f.body,'$.code'))='wf1') ORDER BY id");
  return rows;
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('Wind dataset browser QA timed out'); app.exit(1); }, 240000);
  try {
    db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    realBefore = await realSnapshot(); assert.ok(realBefore.length, 'Expected the existing wf1 dataset');
    const login = await api('session', 'POST', { username: 'admin', password: process.env.BOOTSTRAP_PASSWORD }, ''); adminToken = login.token;
    user = await api('users', 'POST', { username: tenant, password, name: '工况分页与删除验证', role: 'analyst', tenant }, adminToken);
    token = (await api('session', 'POST', { username: tenant, password }, '')).token;
    const farm = (await api('objects', 'POST', { kind: 'farm', code: 'WIND-BROWSER-QA', name: '分页验证风场', parentId: null })).object;
    await api('objects', 'POST', { kind: 'turbine', code: 'QA-T001', name: 'QA-T001', parentId: farm.id });
    const rows = Array.from({ length: 210 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), turbineCode: 'QA-T001',
      windSpeed: i / 10, ...(i % 3 ? { rpm: 6 + i / 100 } : {}), ...(i % 5 ? { powerKw: i } : {}), ...(i % 7 ? { temperatureC: 18 - i / 100 } : {}) }));
    const name = 'QA 分页 210 行 · 缺失指标保留';
    if (!standardOnly) {
      datasetId = (await api('wind-datasets', 'POST', { name, farmId: farm.id, rows })).id;
      assert.ok(datasetId);
    }
    await browser(token);
    await js(`(()=>{const original=window.fetch.bind(window);window.__windQA={requests:[],delayNext:0,errorNext:false};window.fetch=async(input,init)=>{const url=String(typeof input==='string'?input:input.url);const method=init?.method||'GET';if(url.includes('/wind-datasets/')){window.__windQA.requests.push({url,method});if(url.includes('/rows?')){const delay=window.__windQA.delayNext;window.__windQA.delayNext=0;if(delay)await new Promise(r=>setTimeout(r,delay));if(window.__windQA.errorNext){window.__windQA.errorNext=false;return new Response(JSON.stringify({error:'QA临时读取失败'}),{status:503,headers:{'Content-Type':'application/json'}});}}}return original(input,init);};})()`);
    await check('default 50 rows, explicit loading, canonical units and missing values', async () => {
      await js('window.__windQA.delayNext=700'); await datasetAction(name, '预览');
      await until(`document.querySelector('.wind-preview-table[aria-busy="true"]')?.textContent.includes('正在加载本页数据')`, 'loading state');
      assert.equal(await js(`document.querySelector('dialog select[aria-label="每页条数"]').disabled`), true);
      await pageReady(50, 1);
      const state = await js(`({size:document.querySelector('dialog select[aria-label="每页条数"]').value,headers:[...document.querySelectorAll('.wind-preview-table th')].map(e=>e.textContent),first:[...document.querySelector('.wind-preview-table tbody tr').cells].map(e=>e.textContent)})`);
      assert.equal(state.size, '50'); assert.ok(state.headers.some(h => h.includes('m/s'))); assert.ok(state.headers.some(h => h.includes('rpm')));
      assert.ok(state.first.includes('0')); assert.equal(state.first.filter(cell => cell === '—').length, 3); assert.ok(state.first[2].includes('08:00:00'));
      assert.deepEqual(state.headers.slice(0, 3), ['序号', '名称', '时间']);
      await screenshot('qa-preview-50');
    });
    await check('last page is bounded and page size changes reset the offset', async () => {
      await click('末页', `document.querySelector('dialog[open]')`); await pageReady(10, 201);
      assert.equal(await js(`[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()==='下一页').disabled`), true);
      await pageSize(100); await pageReady(100, 1);
      await click('下一页', `document.querySelector('dialog[open]')`); await pageReady(100, 101);
      await click('下一页', `document.querySelector('dialog[open]')`); await pageReady(10, 201);
      await pageSize(20); await pageReady(20, 1); await screenshot('qa-preview-20');
    });
    await check('close and reopen resets to page 1 and 50 rows', async () => {
      await closeDialog(); await datasetAction(name, '预览'); await pageReady(50, 1);
      assert.equal(await js(`document.querySelector('dialog select[aria-label="每页条数"]').value`), '50');
    });
    await check('transient read error is visible and retry recovers the requested page', async () => {
      await js('window.__windQA.errorNext=true'); await click('下一页', `document.querySelector('dialog[open]')`);
      await until(`document.querySelector('.wind-preview-table [role="alert"]')?.textContent.includes('QA临时读取失败')`, 'temporary error');
      assert.equal(await js(`document.querySelectorAll('.wind-preview-table tbody tr').length`), 0);
      await screenshot('qa-preview-error'); await click('重试', `document.querySelector('dialog[open]')`); await pageReady(50, 51);
    });
    await check('1024 viewport keeps table and pagination inside the dialog', async () => {
      win.setContentSize(1024, 900); await sleep(100);
      const size = await js(`(()=>{const d=document.querySelector('dialog[open]'),footer=document.querySelector('.wind-preview-footer'),r=d.getBoundingClientRect(),f=footer.getBoundingClientRect();return {body:document.documentElement.scrollWidth<=innerWidth+2,dialog:d.scrollWidth<=d.clientWidth+2,bounds:r.left>=0&&r.right<=innerWidth+2,footer:f.left>=r.left&&f.right<=r.right+2};})()`);
      assert.ok(Object.values(size).every(Boolean), JSON.stringify(size)); await screenshot('qa-preview-1024');
      await closeDialog();
    });
    await check('cancel deletion preserves all rows without issuing DELETE', async () => {
      await datasetAction(name, '删除'); await until(`document.querySelector('dialog h2')?.textContent==='删除数据集'`, 'delete confirmation');
      await screenshot('qa-delete-confirmation'); await click('取消', `document.querySelector('dialog[open]')`);
      assert.equal(await js(`window.__windQA.requests.filter(r=>r.method==='DELETE').length`), 0);
      assert.equal((await api(`wind-datasets/${datasetId}/rows`)).total, 210);
    });
    await check('confirmed deletion removes only the selected QA dataset', async () => {
      await datasetAction(name, '删除'); await click('确认删除', `document.querySelector('dialog[open]')`);
      await until(`!document.querySelector('dialog[open]')&&![...document.querySelectorAll('.measurement-workspace table tbody tr')].some(e=>e.textContent.includes(${JSON.stringify(name)}))`, 'deleted QA dataset');
      assert.equal((await request(`wind-datasets/${datasetId}/rows`)).status, 404);
      assert.equal(await js(`window.__windQA.requests.filter(r=>r.method==='DELETE').length`), 1);
      report.requests = await js('window.__windQA.requests'); await screenshot('qa-deleted');
      for (const item of report.requests.filter(r => r.url.includes('/rows?'))) assert.ok(Number(new URL(item.url, origin).searchParams.get('limit')) <= 100);
    });
    if (standardCsv) {
      const bytes = fs.readFileSync(standardCsv), sourceHash = createHash('sha256').update(bytes).digest('hex');
      const sourceRows = new TextDecoder('gb18030', { fatal: true }).decode(bytes).trim().split(/\r?\n/).map(line => line.split(','));
      const headings = ['名称', '时间', '风速', '发电机有功功率', '主轴转速', '舱外温度', '风向'];
      assert.deepEqual(sourceRows.shift(), headings); assert.equal(sourceRows.length, 1440);
      await api('objects', 'POST', { kind: 'turbine', code: '006#', name: '006#', parentId: farm.id });
      win.setContentSize(1500, 1050);
      await check('standard seven-column GB18030 CSV maps all metrics and prefills units without automatic import', async () => {
        await selectValue('风场', farm.id);
        win.webContents.debugger.attach('1.3');
        try {
          const { root: doc } = await win.webContents.debugger.sendCommand('DOM.getDocument');
          const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector: '[aria-label="风场数据文件"]' });
          await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [standardCsv] });
        } finally { win.webContents.debugger.detach(); }
        await until(`document.body.innerText.includes('已读取文件。请核对指标单位')`, 'standard CSV prefill');
        assert.equal((await api('wind-datasets')).datasets.length, 0, 'Selecting a file must not auto-import');
        const units = await js(`Object.fromEntries([...document.querySelectorAll('select')].filter(e=>e.getAttribute('aria-label')?.endsWith('原始单位')).map(e=>[e.getAttribute('aria-label'),e.value]))`);
        assert.deepEqual(units, { '风速原始单位': 'm/s', '发电机有功功率原始单位': 'kW', '主轴转速原始单位': 'rpm', '舱外温度原始单位': 'C', '风向原始单位': 'deg' });
        await js(`document.querySelector('.measurement-advanced').open=true`);
        const mapping = await js(`Object.fromEntries([...document.querySelectorAll('.measurement-advanced select')].map(e=>[e.getAttribute('aria-label'),e.value]))`);
        assert.deepEqual(Object.keys(mapping), headings); for (const heading of headings) assert.equal(mapping[heading], heading);
        const previewText = await js(`document.querySelector('.measurement-workspace').innerText`);
        assert.ok(previewText.toLowerCase().includes('gb18030')); assert.ok(previewText.includes('1,440'));
        assert.equal(await js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认单位与时区并导入').disabled`), false);
        await screenshot('standard-csv-mapping-and-units');
        report.standardCsv = { filename: path.basename(standardCsv), sha256: sourceHash, encoding: 'gb18030', rowCount: 1440, headings, units, mapping };
      });
      await check('standard CSV imports 1440 original rows and previews signed direction under 006#', async () => {
        await click('确认单位与时区并导入');
        await until(`document.body.innerText.includes('已保存 1,440 个风机时间点')`, 'standard CSV persisted');
        const saved = (await api('wind-datasets')).datasets;
        assert.equal(saved.length, 1); assert.equal(saved[0].rowCount, 1440);
        const canonical = await api(`wind-datasets/${saved[0].id}/rows?offset=0&limit=50`);
        const source = sourceRows[0], first = canonical.rows[0];
        assert.equal(first.turbineCode, source[0]); assert.equal(first.time, new Date(source[1].replace(' ', 'T') + '+08:00').toISOString());
        for (const [key, index] of [['windSpeed', 2], ['powerKw', 3], ['rpm', 4], ['temperatureC', 5], ['windDirection', 6]]) assert.equal(first[key], Number(source[index]));
        assert.ok(first.windDirection < 0); assert.equal(canonical.units.windDirection, 'deg');
        await datasetAction(saved[0].name, '预览'); await pageReady(50, 1);
        const view = await js(`({headers:[...document.querySelectorAll('.wind-preview-table th')].map(e=>e.textContent),first:[...document.querySelector('.wind-preview-table tbody tr').cells].map(e=>e.textContent),note:document.querySelector('.wind-data-preview').textContent})`);
        assert.deepEqual(view.headers, ['序号', '名称', '时间', '风速 · m/s', '发电机有功功率 · kW', '主轴转速 · rpm', '舱外温度 · °C', '风向 · °']);
        assert.equal(view.first[1], '006#'); assert.ok(view.first[2].includes('00:00:00')); assert.equal(Number(view.first[7]), first.windDirection); assert.ok(view.note.includes('保留原始正负角度'));
        assert.equal(await js(`!!document.querySelector('.wind-preview-jump')`), false, 'No redundant jump when complete metrics start at the first row');
        await screenshot('standard-csv-signed-direction');
        await pageSize(100); await pageReady(100, 1); await click('末页', `document.querySelector('dialog[open]')`); await pageReady(40, 1401);
        const last = await js(`[...document.querySelector('.wind-preview-table tbody tr:last-child').cells].map(e=>e.textContent)`);
        assert.equal(last[0], '1440'); assert.equal(last[1], '006#'); assert.ok(last[2].includes('23:59:00')); assert.equal(Number(last[7]), Number(sourceRows.at(-1)[6]));
        win.setContentSize(1024, 900); await sleep(100);
        assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth+2&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth+2`), true);
        await screenshot('standard-csv-last-page-1024'); await closeDialog();
        assert.equal(createHash('sha256').update(fs.readFileSync(standardCsv)).digest('hex'), sourceHash);
        report.standardCsv.firstRow = first; report.standardCsv.lastVisibleRow = last; report.standardCsv.sourceUnchanged = true;
      });
    }
    if (standardOnly) await check('standard UI hides the redundant jump while R018 retains its useful jump', async () => {
      const cat = await api('wind-datasets', 'GET', undefined, adminToken);
      const realFarm = cat.objects.find(o => o.kind === 'farm' && o.code === 'wf1' && o.active);
      const real = cat.datasets.find(d => d.farmId === realFarm?.id && d.name.includes('R018') && d.rowCount === 186000);
      assert.ok(real); await browser(adminToken, true); await datasetAction(real.name, '预览'); await pageReady(50, 1);
      assert.equal(await js(`document.querySelector('.wind-preview-jump')?.textContent`), '跳到风速与转速齐全时段');
      await closeDialog(); assert.deepEqual(await realSnapshot(), realBefore); report.realDataUnchanged = true;
    });
    await check('real R018 previews in a read-only window with 50/100-row requests', async () => {
      const cat = await api('wind-datasets', 'GET', undefined, adminToken);
      const realFarm = cat.objects.find(o => o.kind === 'farm' && o.code === 'wf1' && o.active);
      const real = cat.datasets.find(d => d.farmId === realFarm?.id && d.name.includes('R018') && d.rowCount === 186000);
      assert.ok(real, 'Existing R018 data unavailable'); report.realDataset = { id: real.id, name: real.name, rowCount: real.rowCount };
      await browser(adminToken, true); await datasetAction(real.name, '预览'); await pageReady(50, 1);
      const first = await js(`[...document.querySelector('.wind-preview-table tbody tr').cells].map(e=>e.textContent)`);
      assert.ok(first[2].includes('08:20:00')); assert.equal(first.filter(value => value === '—').length, 3);
      await screenshot('real-r018-preview-50');
      await pageSize(100); await pageReady(100, 1); win.setContentSize(1024, 900); await sleep(100);
      assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth+2&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth+2`), true);
      await screenshot('real-r018-preview-100-1024');
      await click('跳到风速与转速齐全时段', `document.querySelector('dialog[open]')`);
      await until(`document.querySelector('.wind-preview-table[aria-busy="false"] tbody tr')?.cells[2].textContent.includes('09:10:00')`, 'R018 complete metrics at 09:10');
      const matched = await js(`[...document.querySelector('.wind-preview-table tbody tr').cells].map(e=>e.textContent)`);
      assert.equal(matched.length, 7); assert.ok(matched.slice(3).every(value => value !== '—' && Number.isFinite(Number(value))));
      assert.equal(await js(`document.querySelectorAll('.wind-preview-table tbody tr').length`), 100);
      report.realFirstRow = first; report.realCompleteMetricsRow = matched;
      await screenshot('real-r018-complete-metrics-1024'); await closeDialog();
      assert.deepEqual(await realSnapshot(), realBefore); report.realDataUnchanged = true;
    });
    assert.deepEqual(report.browserErrors, [], 'Unexpected browser console errors');
  } catch (error) {
    failure = error; console.error(safeError(error)); if (win) await screenshot('failure').catch(() => {});
  } finally {
    win?.destroy();
    if (db) {
      try {
        if (realBefore) { assert.deepEqual(await realSnapshot(), realBefore); report.realDataUnchanged = true; }
        // Explicitly bounded to our newly-created tenant and user, never wf1.
        for (const table of ['records', 'audit_logs']) await db.execute(`DELETE FROM ${table} WHERE tenant=?`, [tenant]);
        if (user?.id) {
          await db.execute('DELETE FROM sessions WHERE user_id=?', [user.id]);
          await db.execute('DELETE FROM audit_logs WHERE actor_id=? OR target=?', [user.id, user.id]);
          await db.execute('DELETE FROM users WHERE id=? AND tenant=?', [user.id, tenant]);
          const key = createHash('sha256').update(`${tenant}\0${user.id}`).digest('hex');
          fs.rmSync(path.join(process.env.BLADE_ANALYSIS_DATA_DIR || path.join(root, '.data/web-rotation'), key), { recursive: true, force: true });
        }
        if (adminToken) await request('session', 'DELETE', undefined, adminToken);
        report.qaDataRemoved = true;
      } catch (error) { failure ||= error; report.cleanupError = safeError(error); }
      await db.end();
    }
    fs.rmSync(profile, { recursive: true, force: true });
    report.passed = !failure; if (failure) report.error = safeError(failure);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    clearTimeout(watchdog); console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.checks.length} wind dataset browser checks`); app.exit(failure ? 1 : 0);
  }
});
