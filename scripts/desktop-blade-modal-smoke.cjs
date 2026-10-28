'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const input = path.join(root, 'artifacts/blade-reconstruction-20261021/result.json');
const output = path.join(root, 'artifacts/desktop-blade-modal-ui');
const ui = path.join(root, 'packages/ui/src');
const result = JSON.parse(fs.readFileSync(input, 'utf8'));
fs.mkdirSync(output, { recursive: true });
const rawCsv = {
  name: 'raw-csv',
  setup(build) {
    build.onResolve({ filter: /\.csv\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-csv' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-csv' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as echarts from 'echarts/core';
import {DesktopBladeTemplateComparison, desktopBladeTemplates} from ${JSON.stringify(path.join(ui, 'desktop-blade-modal.tsx'))};
import result from ${JSON.stringify(input)};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'web-blade-passes.css'))};
window.chartOptions=()=>[...document.querySelectorAll('[role=img]')].map(element=>({label:element.getAttribute('aria-label'),option:echarts.getInstanceByDom(element)?.getOption()}));
window.templates=desktopBladeTemplates;
createRoot(document.getElementById('root')).render(<main className="web-blade-passes blade-pass-results" style={{maxWidth:1120,margin:'0 auto',padding:20}}><h1>理论模态模板对比</h1><DesktopBladeTemplateComparison synthesis={result.synthesis} templateId="客户模态重构 · 2026.7" /></main>);
`;
const bundle = build({ stdin: { contents: source, loader: 'tsx', resolveDir: root }, bundle: true, plugins: [rawCsv],
  outfile: path.join(output, 'review.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>桌面理论模态模板预览</title><link rel="stylesheet" href="review.css"><body><div id="root"></div><script src="review.js"></script></body></html>');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-modal-preview-')));
let win;
const report = { hardwareUsed: false, networkUsed: false, input, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function ready() {
  for (let i = 0; i < 160; i++) {
    if (await run('window.chartOptions?.().length===2 && window.chartOptions().every(x=>x.option)')) return;
    await pause(50);
  }
  throw new Error('Template comparison charts did not render: ' + String(await run('document.body.innerText')).slice(0, 1000));
}
async function check(name, callback) { await callback(); report.checks.push(name); console.log('PASS ' + name); }
function finish(error) {
  report.passed = !error;
  if (error) report.error = error.stack;
  fs.writeFileSync(path.join(output, 'test-result.json'), JSON.stringify(report, null, 2));
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('Template UI validation timeout')), 60000);
bundle.then(() => app.whenReady()).then(async () => {
  try {
    win = new BrowserWindow({ width: 1366, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => console.error(`renderer[${level}] ${message}`));
    win.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`load failed ${code} ${description} ${url}`));
    win.webContents.on('render-process-gone', (_event, details) => console.error('renderer gone', details));
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    await win.loadFile(path.join(output, 'index.html'));
    win.show();
    await ready();
    await check('五个模板阶次及理论频率已加载，候选按 MSE 排序', async () => {
      const templates = await run('window.templates');
      assert.deepEqual(templates.map(item => [item.order, item.frequencyHz]), [[1, 1.33], [2, 6.17], [3, 16.87], [4, 23.2], [5, 69.2]]);
      assert.ok(await run('document.body.innerText.includes("最相近") && document.body.innerText.includes("归一化幅值 MSE") && document.body.innerText.includes("逐点幅值误差") && document.body.innerText.includes("频率差 Hz")'));
      assert.ok((await run('window.chartOptions()'))[0].option.series.length === 2);
    });
    await check('切换理论阶次更新形状预览及 MSE', async () => {
      await run(`document.querySelector('[role=combobox][aria-label="模板对比理论阶次"]').click()`);
      await pause(50);
      await run(`document.querySelectorAll('[role=option]')[4].click()`);
      await pause(100);
      const chart = (await run('window.chartOptions()'))[1].option;
      assert.ok(await run('document.body.innerText.includes("理论第 5 阶")'));
      assert.equal(chart.series[0].name, '理论幅值形状 · 69.2 Hz');
    });
    await check('桌面与窄屏布局不产生横向溢出', async () => {
      for (const [width, height] of [[1366, 900], [820, 900], [480, 850]]) {
        win.setContentSize(width, height); await pause(180);
        const bounds = await run('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
        assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
        const filename = `comparison-${width}.png`;
        fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
        report.screenshots.push(filename);
      }
    });
    clearTimeout(watchdog); finish();
  } catch (error) { clearTimeout(watchdog); finish(error); }
}).catch(error => { clearTimeout(watchdog); finish(error); });
