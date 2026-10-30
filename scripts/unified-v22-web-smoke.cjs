'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const f=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.equal(f.origin,'http://127.0.0.1:3210');assert(f.username.startsWith('qa-web-'));
app.setPath('userData',fs.mkdtempSync(path.join(f.output,'browser-')));app.on('window-all-closed',()=>{});let win;const checks=[];
const js=c=>win.webContents.executeJavaScript(c,true);async function until(code,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await js('!!('+code+')'))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timeout: '+code);}
async function click(text){await until(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`);}
async function input(label,value){await js(`(()=>{const e=[...document.querySelectorAll('input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing input '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function screenshot(name){await js("document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,400)))");fs.writeFileSync(path.join(f.output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{let fail;try{
 win=new BrowserWindow({show:false,width:1600,height:1050,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadURL(f.origin);await until("!!document.querySelector('.login-card')");await input('账号',f.username);await input('密码',f.password);await click('登录');await until("!!document.querySelector('nav.sidebar')");
 await js(`sessionStorage.setItem('blade.measurement-context.v2',${JSON.stringify(JSON.stringify({...f.context,...(f.hiddenPositionId?{positionId:f.hiddenPositionId}:{})}))});window.dispatchEvent(new Event('blade-measurement-context'));window.location.hash='blade';`);
 async function composition(){await new Promise(r=>setTimeout(r,500));if(await js("!!document.querySelector('[aria-label=跨任务分组依据]')")){await js("(()=>{const e=[...document.querySelectorAll('input[type=checkbox]')].find(e=>e.closest('label')?.innerText.includes('建立跨原始任务'));if(e&&!e.checked)e.click()})()");await input('跨任务分组依据','QA real source scope, software review only');}}
 await composition();await until("document.querySelector('select[aria-label=分析数据记录]')?.options.length===20");
 const sourceLayout=await js("(()=>{const l=document.querySelector('.measurement-processing-source'),caption=l.querySelector(':scope>span'),c=l.querySelector('[role=combobox]'),a=caption.getBoundingClientRect(),b=c.getBoundingClientRect();return {gap:b.left-a.right,custom:!!c.closest('.custom-select'),height:b.height};})()");
 assert(sourceLayout.custom&&sourceLayout.gap>=10&&sourceLayout.height>=38,'Processing source must use the standard dropdown with label spacing');
 await js("document.querySelector('[role=combobox][aria-label=统一处理来源]').click()");await until("!!document.querySelector('[role=option]')");
 assert(await js("[...document.querySelectorAll('[role=option]')].some(e=>e.textContent==='同方案 Web 重算')"));
 await js("[...document.querySelectorAll('[role=option]')].find(e=>e.textContent==='同方案 Web 重算').click()");
 checks.push('Processing source uses the standard component with a 12px label gap and selectable popup');
 await js("(()=>{const e=document.querySelector('select[aria-label=分析数据记录]'),o=[...e.options].find(o=>o.text.includes('－P2－0°'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,o.value);e.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await click('开始分析');await until("!!document.querySelector('[data-analysis-card=SIG-STFT] canvas')");await screenshot('01-Web-signal');checks.push('Shared real segment FFT, Welch and fixed STFT view');
 await js("window.location.hash='modal'");await composition();await until("document.body.innerText.includes('叶片响应分析')&&document.querySelector('.desktop-analysis-workspace .dra-settings')");
 await js("document.querySelector('.dra-settings').open=true");
 assert(await js("document.querySelector('select[aria-label=频带用途]')?.value==='preview'"));
 assert(!await js("!!document.querySelector('input[aria-label=目标频带下限]')"),'Automatic preview must not require custom frequencies or prose');
 await js("(()=>{const original=window.fetch;window.__holdPreview=true;window.fetch=async function(url,opts){if(window.__holdPreview&&String(url).includes('/measurements/processing')&&JSON.parse(opts?.body||'{}').request?.action==='preview')await new Promise(r=>{window.__releasePreview=r;});return original.apply(this,arguments);};})()");
 await click('开始分析');await until("document.querySelectorAll('[data-analysis-card^=SYN-PSD-] canvas').length===5");await until("document.querySelector('[data-analysis-card=SYN-BAND] canvas')&&document.querySelector('[data-analysis-card=SYN-AMPLITUDE] canvas')");
 await until("typeof window.__releasePreview==='function'&&!!document.querySelector('[data-analysis-card=SYN-WAVE-P2] [role=status]')");
 assert(!await js("!!document.querySelector('[data-analysis-card=SYN-WAVE-P2] canvas')"),'Unfinished Web previews must not show partial waveform data');
 await js("document.querySelector('[data-analysis-card=SYN-WAVE-P2]').scrollIntoView({block:'center'})");await screenshot('12-Web-preview-pending');
 await js("window.__holdPreview=false;window.__releasePreview()");
 await until("!!document.querySelector('[data-analysis-card=SYN-WAVE-P5] canvas')");
 await until("![...document.querySelectorAll('.fra-plot-wrap')].some(e=>e.getAttribute('aria-busy')==='true')&&!document.querySelector('[data-analysis-card^=SYN-WAVE-] [role=status]')");
 checks.push('Pending Web previews retain loading until real data and chart painting finish');
 await screenshot('02-Web-response-five-points');
 await js("document.querySelector('[data-analysis-card=SYN-BAND]').scrollIntoView({block:'center'})");await screenshot('07-Web-automatic-response-band');assert.equal(await js("document.querySelectorAll('[data-analysis-card^=SYN-WAVE-]').length"),5);checks.push('5 waveforms + 5 PSD + band + amplitude + source coverage');
 await click('模态参数识别');await until("document.body.innerText.includes('不要求重复上传')");
 await click('从已保存数据选取');await until("!!document.querySelector('dialog[open] [data-native-modal-input]')");
 await until("document.querySelector('select[aria-label=模态来源处理版本]')?.options.length>0");
 await until("document.querySelector('select[aria-label=模态来源连续段]')?.options.length>1&&!!document.querySelector('select[aria-label=模态来源连续段]')?.value");
 const nativeLayout=await js("(()=>{const d=document.querySelector('dialog[open]'),controls=[...d.querySelectorAll('[data-native-modal-input] [role=combobox]')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};}),buttons=[...document.querySelectorAll('.formal-modal-toolbar button')].map(e=>e.getBoundingClientRect().height);return {controls,buttons,within:d.scrollWidth<=d.clientWidth+2};})()");
 assert.equal(nativeLayout.controls.length,2);assert(Math.abs(nativeLayout.controls[0].y-nativeLayout.controls[1].y)<2,'Native selectors must align');
 assert(Math.abs(nativeLayout.controls[0].height-nativeLayout.controls[1].height)<2);assert(nativeLayout.controls[1].x-nativeLayout.controls[0].right>=15,'Selectors require consistent horizontal spacing');
 assert(Math.max(...nativeLayout.buttons)-Math.min(...nativeLayout.buttons)<2,'Toolbar buttons must share one height');assert(nativeLayout.within);
 await screenshot('06-Web-modal-native-input');
 for(const width of [1366,1024]){win.setContentSize(width,950);await new Promise(r=>setTimeout(r,200));assert(await js("(()=>{const d=document.querySelector('dialog[open]');return d.scrollWidth<=d.clientWidth+2&&d.getBoundingClientRect().right<=innerWidth;})()"));await screenshot('08-Web-picker-'+width);}
 win.setContentSize(1600,1050);
 checks.push('Native picker fields align, toolbar buttons have equal heights, and dialog fits 1366/1024 widths');
 assert(!await js("!!document.querySelector('dialog[open] input[aria-label=模态输入标定依据]')"));
 assert(await js("document.querySelector('dialog[open] [data-native-advanced]')?.open===false"),'Crop and experiment details must be optional');
 assert(await js("[...document.querySelectorAll('dialog[open] button')].some(b=>b.textContent.trim()==='使用此连续段'&&!b.disabled)"),'Picking a real segment must not require arbitrary prose');
 await click('使用此连续段');await until("!document.querySelector('dialog[open] [data-native-modal-input]')");
 await until("!![...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('真实连续输入'))?.querySelector('select')?.value");
 await until("document.body.innerText.includes('当前输入未提供激励停止后的连续衰减实验记录')");
 assert(await js("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='检查并识别'&&!b.disabled)"),'A selected input must allow an explicit eligibility check');
 await js("(()=>{window.__modalStarts=0;const original=window.fetch;window.fetch=function(url,opts){if(String(url).includes('/formal-modal')&&JSON.parse(opts?.body||'{}').action==='start')window.__modalStarts++;return original.apply(this,arguments);};})()");
 await click('检查并识别');await until("document.querySelector('[data-modal-assessment=checked]')?.textContent.includes('条件检查未通过')");
 assert.equal(await js('window.__modalStarts'),0,'A blade-pass input must not be falsely submitted as a free-decay experiment');
 assert(await js("document.querySelector('[data-modal-assessment=checked]').textContent.includes('敲击')"));
 await screenshot('10-Web-modal-condition-check');checks.push('Selected data can be checked, with actionable method requirements and no ineligible estimator request');
 checks.push('Visible native picker loads versions and segments despite a hidden point filter, and selects a real input without a file upload');
 await until("[...document.querySelectorAll('select option')].some(o=>o.value==="+JSON.stringify(f.modalJobId)+")");
 await js("(()=>{const original=window.fetch;window.__holdModalResult=true;window.fetch=async function(url,opts){if(window.__holdModalResult&&String(url).includes('/formal-modal')&&JSON.parse(opts?.body||'{}').action==='result')await new Promise(r=>{window.__releaseModalResult=r;});return original.apply(this,arguments);};})()");
 await js(`(()=>{const e=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('历史版本')).querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(f.modalJobId)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until("typeof window.__releaseModalResult==='function'&&[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('正在读取模态参数与图表'))");
 assert(!await js("!!document.querySelector('[data-analysis-card=MOD-DECAY] canvas')"));await js("window.__holdModalResult=false;window.__releaseModalResult()");
 await until("!!document.querySelector('[data-analysis-card=MOD-DECAY] canvas')");await screenshot('03-Web-modal-method-evidence');checks.push('Saved modal history displays loading until its actual estimator evidence arrives');
 for(const width of [1366,1024]){win.setContentSize(width,950);await new Promise(r=>setTimeout(r,250));assert(await js('document.documentElement.scrollWidth<=window.innerWidth+2'),'overflow '+width);await screenshot('04-Web-responsive-'+width);}
 win.setContentSize(1600,1050);await js("window.location.hash='health'");await until("document.querySelectorAll('.blade-health-slot').length===3");
 for(const width of [1600,1024,760]){
  win.setContentSize(width,1050);await new Promise(r=>setTimeout(r,100));
  const buttons=await js("[...document.querySelectorAll('.measurement-heading-actions button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})");
  assert.equal(buttons.length,3);
  for(let i=0;i<buttons.length;i++){assert(buttons[i].right<=width+1,'Health action must remain inside viewport');for(let j=0;j<i;j++){const a=buttons[j],b=buttons[i];if(Math.abs(a.top-b.top)<2)assert(b.left-a.right>=9,'Adjacent health actions require 10px spacing');else assert(b.top-a.bottom>=9||a.top-b.bottom>=9,'Wrapped health actions require a vertical gap');}}
  await screenshot('13-Web-health-actions-'+width);
 }
 checks.push('Health actions maintain 10px horizontal and wrapped-row gaps at 1600/1024/760 widths');
 win.setContentSize(1600,1050);await click('异常证据与结论');await until("document.body.innerText.includes('algorithm_not_connected')");assert(await js("[...document.querySelectorAll('button')].some(b=>b.disabled&&b.textContent.includes('专项损伤检测'))"));await screenshot('05-Web-health-reserved-damage');checks.push('Health version reuse and explicit disabled specialty damage');
 await js("window.location.hash='wind'");await until("!!document.querySelector('input[aria-label=风场数据文件]')");
 await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='选择 CSV / XLSX'&&!b.disabled)");
 assert(await js("(()=>{const e=document.querySelector('input[aria-label=风场数据文件]');return e.hidden&&e.multiple&&getComputedStyle(e).display==='none';})()"),'Native file input must be visually hidden while preserving multiple selection');
 await js("(()=>{window.__filePickerClicks=0;document.querySelector('input[aria-label=风场数据文件]').click=()=>window.__filePickerClicks++;})()");
 await click('选择 CSV / XLSX');assert.equal(await js('window.__filePickerClicks'),1);await screenshot('11-Web-wind-file-picker');
 const windLayout=await js("(()=>{const a=document.querySelector('.wind-import-controls [role=combobox]').getBoundingClientRect(),b=document.querySelector('.wind-file-actions .btn').getBoundingClientRect();return {height:Math.abs(a.height-b.height),top:Math.abs(a.top-b.top),gap:b.left-a.right};})()");
 assert(windLayout.height<2&&windLayout.top<2&&windLayout.gap>=14,'Wind farm and file controls must align');
 checks.push('Standard wind-file button opens the hidden multi-file input');
 fs.writeFileSync(path.join(f.output,'ui-acceptance.json'),JSON.stringify({passed:true,checks},null,2));console.log('PASS unified V2.2 Web UI');
 }catch(e){fail=e;console.error(e.stack);if(win){await screenshot('failed');fs.writeFileSync(path.join(f.output,'failed-text.txt'),await js('document.body.innerText'));}}finally{win?.destroy();app.exit(fail?1:0);}});
