'use strict';
// Builds a standalone UI fixture from the pure geometry module. No acquisition
// controller, Electron production preload, serial or network is ever loaded.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'motion-trial-ui-review');
function buildReview() {
  fs.mkdirSync(output, { recursive: true });
  const python = path.join(root, 'services/acquisition/.venv/bin/python');
  const data = JSON.parse(execFileSync(fs.existsSync(python) ? python : 'python3', ['-c', `
import json
from blade_acquisition.motion_trial import MotionTrialConfig, preview_full_circle
reason = "当前转盘接口尚未接入整圈连续轨迹，需要配套控制板固件及轨迹执行协议"
results = []
for period, axis1sign in ((30, 1), (5, 1), (10, 1), (30, -1), (5, -1)):
    config = MotionTrialConfig(periodSeconds=period, axis1Sign=axis1sign)
    preview = preview_full_circle(config)
    preview.update(capability={"supported": False, "checkedHardware": False, "source": "client_protocol", "code": "trajectory_protocol_unavailable", "message": reason}, blockReasons=[reason])
    results.append({"config": config.model_dump(), "preview": preview})
print(json.dumps(results, ensure_ascii=False))
`], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'services/acquisition') }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  fs.writeFileSync(path.join(output, 'preview.json'), JSON.stringify(data, null, 2) + '\n');
  const ui = path.join(root, 'packages/ui/src');
  const fixture = `
import React, { useEffect, useState } from 'react';
import {createRoot} from 'react-dom/client';
import {FieldSinglePoint} from ${JSON.stringify(path.join(ui, 'field-single-point.tsx'))};
import plans from ${JSON.stringify(path.join(output, 'preview.json'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-single-point.css'))};
localStorage.setItem('blade-motion-trial-geometry-v1',JSON.stringify(location.hash.includes('legacy')?{...plans[0].config,periodSeconds:5,axis1Sign:-1}:plans[0].config));
const initial={service:{state:'ready',dllConfigured:true,generation:1},state:'idle'};
window.__motionFixture={calls:[],navigations:0,hold:false,release:null,noHardware:true};
function App(){
 const [status,setStatus]=useState(initial),[config,setConfig]=useState({name:'界面离线验收',deviceIp:'198.51.100.10',hostIp:'198.51.100.11',object:'',turbine:'',point:''});
 window.__motionFixture.inject=setStatus;
 async function request(options){
  window.__motionFixture.calls.push(options);
  if(options.action!=='motionTrial'||options.request.action!=='preview')throw Error('隔离预览不支持设备请求');
  const record=plans.find(p=>Object.keys(p.config).every(k=>p.config[k]===options.request.config[k]));
  if(!record)throw Error('此隔离验收页只包含当前模型 30 秒及旧周期回归所需的纯数学计算结果。');
  if(window.__motionFixture.hold)await new Promise(resolve=>window.__motionFixture.release=resolve);
  return {...initial,motionTrialPreview:record.preview};
 }
 useEffect(()=>{
  window.__motionFixture.ready=true;
  if(location.hash.startsWith('#capture'))return;
  const timer=setInterval(()=>{
   const tab=[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent==='转速试运行');
   if(tab?.getAttribute('aria-selected')!=='true'){tab?.click();return;}
   const button=[...document.querySelectorAll('.motion-trial-workspace button')].find(e=>e.textContent==='计算整圈轨迹');
   if(button&&!button.disabled){button.click();clearInterval(timer);}
  },50);
  return()=>clearInterval(timer);
 },[]);
 return <div className="field-app"><div className="field-header"><div className="field-brand">BladeVMS <small>界面离线验收 · 不连接设备</small></div></div><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button className="active">单点跟随</button><button>转盘点位</button><button>本机记录</button></aside><main className="field-content"><div className="field-page-heading"><h1>单叶片 · 单测点跟随</h1></div><FieldSinglePoint config={config} onConfig={setConfig} status={status} request={request} onStatus={setStatus} onTurntable={()=>{window.__motionFixture.navigations++;}} onRecords={()=>{}} /></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
  buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BladeVMS 整圈轨迹界面验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(output, 'fixture-evidence.json'), JSON.stringify({ hardwareUsed: false, dataSource: 'services/acquisition/blade_acquisition/motion_trial.py:preview_full_circle', config: data[0].config, samples: data[0].preview.trajectory.length, executionReady: false, rendererNetwork: 'no external resources', purpose: 'isolated UI review only' }, null, 2) + '\n');
  return output;
}
module.exports = { buildReview, output };
if (require.main === module) console.log(buildReview());
