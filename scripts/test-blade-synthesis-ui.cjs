'use strict';
// Render an already-computed result; never calls devices, APIs or databases.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || 'artifacts/blade-reconstruction-20261022/result.json');
const result = JSON.parse(fs.readFileSync(input, 'utf8'));
const output = path.join(root, 'artifacts/blade-synthesis-ui');
fs.mkdirSync(output, { recursive: true });
const ui = path.join(root, 'packages/ui/src');
const code = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as echarts from 'echarts/core';
import {BladeSynthesisResults} from ${JSON.stringify(path.join(ui, 'web-blade-synthesis.tsx'))};
import result from ${JSON.stringify(input)};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'web-rotation.css'))};
import ${JSON.stringify(path.join(ui, 'web-blade-passes.css'))};
window.chartOptions=()=>[...document.querySelectorAll('[role=img]')].map(element=>({label:element.getAttribute('aria-label'),option:echarts.getInstanceByDom(element)?.getOption()}));
createRoot(document.getElementById('root')).render(<main className="web-rotation-workspace" style={{maxWidth:1500,margin:'0 auto',padding:20}}><h1 style={{fontSize:24}}>叶片有效数据合并与空间响应</h1><p>叶片 {result.bladeId} · 实测数据离线查看</p><div className="web-blade-passes blade-pass-results"><BladeSynthesisResults synthesis={result.synthesis}/></div></main>);
`;
buildSync({ stdin: { contents: code, loader: 'tsx', resolveDir: root }, bundle: true,
  outfile: path.join(output, 'review.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>叶片分段合成实测验证</title><link rel="stylesheet" href="review.css"><body><div id="root"></div><script src="review.js"></script></body></html>');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blade-synthesis-ui-')));
let win;
const report = { hardwareUsed: false, networkUsed: false, input, checks: [], screenshots: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = code => win.webContents.executeJavaScript(code, true);
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (await run('window.chartOptions?.().length===3 && window.chartOptions().every(x=>x.option)')) return;
    await pause(50);
  }
  throw new Error('Charts did not render');
}
async function choose(label, index) {
  await run(`document.querySelector('[role=combobox][aria-label="${label}"]').click()`);
  await pause(50);
  await run(`document.querySelectorAll('[role=option]')[${index}].click()`);
  await pause(100);
}
async function check(name, callback) { await callback(); report.checks.push(name); console.log('PASS ' + name); }
function finish(error) {
  report.passed = !error;
  if (error) report.error = error.stack;
  fs.writeFileSync(path.join(output, 'test-result.json'), JSON.stringify(report, null, 2));
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('UI validation timeout')), 60000);
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1366, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:')}));
    await win.loadFile(path.join(output, 'index.html'));
    await ready();
    await check('真实记录的合并分段和压缩坐标一致', async () => {
      const chart = (await run('window.chartOptions()'))[0].option;
      const point = result.synthesis.mergedPoints[0];
      assert.equal(chart.series.length, point.segments.length);
      point.segments.forEach((segment, i) => {
        const first = segment.timeDomain.seconds[0] - segment.originalStartSeconds + segment.compressedStartSeconds;
        assert.ok(Math.abs(chart.series[i].data[0][0] - first) < 1e-12);
        assert.equal(chart.series[i].connectNulls, false);
      });
    });
    await check('探索频带幅值来自计算结果，未伪装共同模态', async () => {
      const chart = (await run('window.chartOptions()'))[1].option;
      const response = (result.synthesis.candidates.length ? result.synthesis.candidates : result.synthesis.bandResponses)[0];
      assert.deepEqual(chart.series[0].data, response.points.map(point => [point.radiusM, point.normalizedAmplitude]));
      if (!result.synthesis.candidates.length) assert.ok(await run('document.body.textContent.includes("预设频带的探索曲线")'));
      assert.ok(await run('document.body.textContent.includes("节点正负未知")'));
    });
    await check('切换测点与频带，周期滑块更新同相假设预览', async () => {
      await choose('合并数据径向测点', result.synthesis.mergedPoints.length - 1);
      let chart = (await run('window.chartOptions()'))[0].option;
      assert.equal(chart.series.length, result.synthesis.mergedPoints.at(-1).segments.length);
      const responses = result.synthesis.candidates.length ? result.synthesis.candidates : result.synthesis.bandResponses;
      if (responses.length > 1) {
        await choose('振型候选频带', 1);
        chart = (await run('window.chartOptions()'))[1].option;
        assert.deepEqual(chart.series[0].data, responses[1].points.map(point => [point.radiusM, point.normalizedAmplitude]));
      }
      await run(`(()=>{const e=document.querySelector('input[aria-label="同相假设周期相位"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'270');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await pause(100);
      chart = (await run('window.chartOptions()'))[2].option;
      assert.ok(chart.series[0].data.every(point => point[1] <= 0));
    });
    await check('桌面和平板手机尺寸图表正常，无页面横向溢出', async () => {
      for (const [width, height] of [[1366, 900], [820, 900], [480, 850]]) {
        win.setContentSize(width, height); await pause(180);
        const bounds = await run('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
        assert.ok(bounds.scroll <= bounds.width + 2, JSON.stringify(bounds));
        for (const [section, selector] of [['merged', 'section:first-child'], ['shape', 'section:last-child']]) {
          await run(`document.querySelector('${selector}').scrollIntoView({block:'start'})`); await pause(100);
          const filename = `${section}-${width}.png`;
          fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
          report.screenshots.push(filename);
        }
      }
    });
    clearTimeout(watchdog); finish();
  } catch (error) { clearTimeout(watchdog); finish(error); }
});
