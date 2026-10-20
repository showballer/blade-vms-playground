'use strict';
// Static renderer fixture: never loads a production preload, DAQ service, or network client.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/auto-follow-ui-review');
function buildReview() {
  fs.mkdirSync(output, { recursive: true });
  const ui = path.join(root, 'packages/ui/src');
  const fixture = `
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FieldTurntableWorkspace} from ${JSON.stringify(path.join(ui, 'field-auto-follow.tsx'))};
import ${JSON.stringify(path.join(ui, 'styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-styles.css'))};
import ${JSON.stringify(path.join(ui, 'field-turntable.css'))};
import ${JSON.stringify(path.join(ui, 'field-auto-follow.css'))};
const axis=(angle,limit)=>({output_angle_deg:angle,motor_rpm:0,actual_counts:0,commanded_counts:0,error_counts:0,display_mode:3,command_counts_per_rev:10000,encoder_bits:17,flags:3,fault:0,origin_counts:0,home_phase:0,observedAt:1792400000,referenceAngleDeg:0,guard:{soft_enabled:true,hardware_enabled:false,minimum_deg:-limit,maximum_deg:limit}});
const ready={service:{state:'ready',dllConfigured:true,generation:1},state:'idle',turntable:{state:'idle',port:'COM3',connected:true,motionCapability:{supported:true,mode:'dual_axis_timed',protocol:'0x30-0x36',probe:'confirmed',status:null},feedback:{outputRpm:0,motorRpm:0,alarmCode:0,limitFlags:0,positionRaw:0,axes:{'1':axis(10,35),'2':axis(0,180)}}}};
window.__autoFixture={calls:[],statusUpdates:[],noHardware:true};
function App(){
 const [status,setStatus]=useState(ready),[config,setConfig]=useState({name:'1号风机检修任务',deviceIp:'198.51.100.10',hostIp:'198.51.100.11',object:'风机叶片',turbine:'WT01',point:''});
 const [autoTargetKey,setAutoTargetKey]=useState(''),[routeMode,setRouteMode]=useState('manual');
 window.__autoFixture.inject=next=>setStatus(next);window.__autoFixture.initial=ready;
 window.__autoFixture.select=key=>setAutoTargetKey(key);
 const accept=next=>{window.__autoFixture.statusUpdates.push(next.state);setStatus(next);};
 async function request(options){
  window.__autoFixture.calls.push(options);
  if(options.action==='turntablePorts'){if(window.__autoFixture.holdPorts)await new Promise(resolve=>window.__autoFixture.releasePorts=resolve);return {ports:window.__autoFixture.ports||[{port:'COM3',description:'隔离验收串口'}]};}
  if(options.action==='turntable'&&options.request.action==='probe'){
   const reply=structuredClone(window.__autoFixture.probeStatus||ready);
   if(window.__autoFixture.holdProbe)await new Promise(resolve=>window.__autoFixture.releaseProbe=resolve);
   return reply;
  }
  throw Error('此离线验收页不提供真实设备操作');
 }
 useEffect(()=>{window.__autoFixture.ready=true;},[]);
 return <div className="field-app"><header className="field-header"><div className="field-brand">BladeVMS <small>隔离界面验收 · 不连接设备</small></div></header><div className="field-workspace"><aside className="field-sidebar"><p>现场作业</p><button>数据采集</button><button className="active">转盘点位</button><button>本机记录</button><button>设备与服务</button></aside><main className="field-content"><div className="field-page-heading"><h1>转盘点位控制</h1></div><FieldTurntableWorkspace config={config} onConfig={setConfig} status={status} disabled={false} request={request} onStatus={accept} onService={()=>{}} onRecords={()=>{}} routeMode={routeMode} onRouteMode={setRouteMode} autoTargetKey={autoTargetKey} onAutoTarget={setAutoTargetKey} onRoute={route=>{window.__autoFixture.routes={...window.__autoFixture.routes,[route.kind]:route};}} onAcquisition={()=>{window.__autoFixture.navigation=(window.__autoFixture.navigation||0)+1;}} /></main></div></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
  buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BladeVMS 自动跟随隔离验收</title><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(output, 'fixture-evidence.json'), JSON.stringify({ hardwareUsed: false, requests: 'in-memory fixture only', purpose: 'isolated renderer review; not physical acceptance' }, null, 2));
  return output;
}
module.exports = { buildReview, output };
if (require.main === module) console.log(buildReview());
