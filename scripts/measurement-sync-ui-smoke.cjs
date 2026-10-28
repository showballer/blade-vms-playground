'use strict';
// Used by test-native-capture-sync-e2e with an isolated temporary QA account.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(fixture.origin,'http://127.0.0.1:3210');
assert(fixture.username.startsWith('qa-native-'));
const profile=fs.mkdtempSync(path.join(path.dirname(process.argv[2]),'browser-'));
app.setPath('userData',profile); app.on('window-all-closed',()=>{});
let win;
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(code){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(await js(code))return; await new Promise(r=>setTimeout(r,100));}
  throw Error('UI condition timed out: '+code);
}
async function click(label){
  await until(`(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`);
}
async function setInput(label,value){
  await js(`(()=>{const el=[...document.querySelectorAll('input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.trim()===${JSON.stringify(label)});if(!el)throw Error('Missing login field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
app.whenReady().then(async()=>{
  let failure;
  try {
    win=new BrowserWindow({show:false,width:1600,height:1100,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await win.loadURL(fixture.origin+'/#blade');
    await until("!!document.querySelector('.login-card')");
    await setInput('账号',fixture.username);await setInput('密码',fixture.password);await click('登录');
    await until("!!document.querySelector('nav.sidebar')");
    await click('旋转测振');await click('实时预览');
    await until("document.querySelector('.measurement-live-grid')?.textContent.includes('保存记录预览')");
    await until("!!document.querySelector('.measurement-live-grid .field-wave-svg path, .measurement-live-grid canvas')");
    await until("document.body.innerText.includes('4 条来源')");
    const state=await js(`(()=>{const grid=document.querySelector('.measurement-live-grid');return {text:grid.innerText,errors:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),loading:!!grid.querySelector('[role=status]'),plots:grid.querySelectorAll('.field-wave-svg,canvas').length,selects:[...document.querySelectorAll('select')].map(e=>e.textContent)}})()`);
    assert(state.text.includes('P3')); assert(state.text.includes('诊断记录'));assert(state.text.includes('记录已上传'));
    assert.equal(state.errors.length,0);assert(state.plots>0);
    await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
    fs.writeFileSync(path.join(fixture.output,'native-sync-preview.png'),(await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(fixture.output,'ui-verification.json'),JSON.stringify({passed:true,actualHistoricalSamples:true,hardwareTested:false,...state},null,2));
    console.log('PASS real P3 archive -> unified task selector -> Web waveform render');
  }catch(e){failure=e;console.error(e.message);if(win)fs.writeFileSync(path.join(fixture.output,'native-sync-preview-failed.png'),(await win.webContents.capturePage()).toPNG());}
  finally{win?.destroy();app.exit(failure?1:0);}
});
