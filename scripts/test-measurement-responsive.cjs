// Local real-data visual regression. Reads existing records; does not control devices.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const signedRms=process.argv.includes('--signed-rms');
const check3d=process.argv.includes('--3d')||signedRms;
const root=path.resolve(__dirname,'..'),out=path.join(root,signedRms?'artifacts/amplitude-sign-review-20261028/ui':check3d?'artifacts/rotation-3d-20261027':'artifacts/rotation-responsive-20261027');
const before=process.argv.includes('--before');
process.loadEnvFile(path.join(root,'apps/web/.env.local'));fs.mkdirSync(out,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(out,'profile-')));app.on('window-all-closed',()=>{});
let win;const js=s=>win.webContents.executeJavaScript(s,true);
async function until(s){const end=Date.now()+30000;while(Date.now()<end){if(await js(s))return;await new Promise(r=>setTimeout(r,80));}throw Error('UI timeout '+s);}
async function click(text){await until(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}||x.getAttribute('aria-label')===${JSON.stringify(text)});if(!b||b.disabled)return false;b.scrollIntoView({block:'nearest'});b.click();return true})()`);}
async function field(label,value){await js(`(()=>{const el=[...document.querySelectorAll('input')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.closest('label')?.querySelector('span')?.textContent.trim()===${JSON.stringify(label)});if(!el)throw Error('Missing field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function settle(){await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");await new Promise(r=>setTimeout(r,250));}
async function shot(name){await settle();fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>app.exit(1),180000),checks=[],errors=[];
 try{
  win=new BrowserWindow({show:false,width:2821,height:1420,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'responsive-'+Date.now()}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
  await win.loadURL('http://127.0.0.1:3210/#blade');await until("!!document.querySelector('.login-card')");await field('账号','admin');await field('密码',process.env.BOOTSTRAP_PASSWORD);await click('登录');
  await until("!!document.querySelector('[aria-label=\"选择测点\"]')&&!document.querySelector('.measurement-loading')");
  await until("!!document.querySelector('[aria-label=\"有效片段拼接波形\"] canvas')");
  await click('P4');await until("!!document.querySelector('[aria-label=\"有效片段拼接波形\"] canvas')");
  for(const width of before?[2821]:[1024,1440,1920,2821]){
   win.setContentSize(width,width===2821?1420:1050);await settle();await js("document.querySelector('.workspace').scrollTo(0,0)");await shot(`${before?'before':'after'}-${width}`);
   const metrics=await js(`(()=>{const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}};return {workspace:rect('.workspace'),content:rect('.web-rotation-workspace'),charts:[...document.querySelectorAll('.measurement-charts [role=img]')].map(e=>({height:e.clientHeight,width:e.clientWidth,canvasHeight:parseFloat(e.querySelector('canvas')?.style.height||'0')})),bodyOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   checks.push({width,...metrics});
   if(!before){assert(metrics.content.width>metrics.workspace.width-100,'Unused width: '+JSON.stringify(metrics));assert.equal(metrics.bodyOverflow,false);for(const c of metrics.charts){assert(c.height>=330);assert(Math.abs(c.canvasHeight-c.height)<2);}}
   await js("document.querySelector('.measurement-charts').scrollIntoView({block:'start'})");await shot(`${before?'before':'after'}-${width}-charts`);
  }
  if(!before){
   // Exercise the visible time-slider handle using actual Chromium pointer events.
   const slider=await js(`(()=>{const e=document.querySelector('[aria-label="有效片段拼接波形"]'),r=e.getBoundingClientRect();return {x:Math.round(r.left+74),y:Math.round(r.bottom-30),to:Math.round(r.left+74+(r.width-98)*.3)}})()`);
   await js(`window.__chartLabels=[];window.__drawText=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__chartLabels.push(String(text));return window.__drawText.call(this,text,...args)};void 0`);
   win.webContents.sendInputEvent({type:'mouseMove',x:slider.x,y:slider.y});
   win.webContents.sendInputEvent({type:'mouseDown',x:slider.x,y:slider.y,button:'left',clickCount:1});
   for(let i=1;i<=8;i++)win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(slider.x+(slider.to-slider.x)*i/8),y:slider.y,button:'left'});
   win.webContents.sendInputEvent({type:'mouseUp',x:slider.to,y:slider.y,button:'left',clickCount:1});
   win.webContents.sendInputEvent({type:'mouseMove',x:210,y:60});await settle();
   const labels=await js('window.__chartLabels');assert(labels.length>0,'Dragging slider must redraw the chart');
   await js('CanvasRenderingContext2D.prototype.fillText=window.__drawText;void 0');
   checks.push({timeSliderDragged:true,redrawnLabels:[...new Set(labels)]});await shot('after-2821-zoom');
   await js(`window.__synthesisResult=null;const originalFetch=window.fetch;window.fetch=async function(...args){const r=await originalFetch.apply(this,args);if(String(args[0]).includes('/measurements/synthesis'))r.clone().json().then(value=>window.__synthesisResult={status:r.status,value});return r};void 0`);
   await click('振幅合成');
   assert(await js(`document.querySelector('[aria-label="合成纳入诊断数据"]')?.checked===false`));
   assert(await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='合成当前叶片')?.disabled===true`));
   await js(`document.querySelector('[aria-label="合成纳入诊断数据"]').click()`);await click('合成当前叶片');
   await until('window.__synthesisResult!==null');
   const synthesis=await js('window.__synthesisResult');assert.equal(synthesis.status,200,JSON.stringify(synthesis.value));
   const result=synthesis.value;
   assert.equal(result.coverage.selectedRecords,20);assert.equal(result.coverage.includedRecords,19);
   assert(Math.abs(result.coverage.validSeconds-2.53)<1e-8);assert.equal(result.synthesis.mergedPoints.length,5);
   assert.equal(result.synthesis.measuredPhaseAvailable,false);
   await until(`document.querySelectorAll('.measurement-synthesis canvas').length>=3`);await settle();
   if(check3d){
    await until(`!!document.querySelector('.measurement-response-3d svg')`);
    const labels=await js(`document.querySelector('.measurement-response-3d').textContent`);
    for(const p of ['P1','P2','P3','P4','P5'])assert(labels.includes(p),`3D missing ${p}`);
    const markers=()=>js(`Array.from(document.querySelectorAll('[data-response-point]')).map(e=>({id:e.getAttribute('data-response-point'),radius:Number(e.getAttribute('data-radius-m')),amplitude:Number(e.getAttribute('data-amplitude'))}))`);
    const initial=await markers();assert.equal(initial.length,5);
    if(signedRms){
     assert(await js(`!!document.querySelector('[data-response-zero-plane]')`));
     assert.equal(await js(`document.querySelectorAll('[data-response-negative-point]').length`),5);
     const mirror=await js(`Array.from(document.querySelectorAll('[data-response-negative-point]')).map(e=>({id:e.getAttribute('data-response-negative-point'),amplitude:Number(e.getAttribute('data-reference-amplitude'))}))`);
     for(const p of initial)assert.equal(mirror.find(x=>x.id===p.id).amplitude,-p.amplitude);
     assert(await js(`document.querySelector('.measurement-response-3d').textContent.includes('不是最大摆幅或真实运动边界')`));
     await js(`document.querySelector('.measurement-response-reference-toggle input').click()`);await settle();
     assert.equal(await js(`document.querySelectorAll('[data-response-negative-point]').length`),0);
     assert.deepEqual(await markers(),initial,'Removing mirror must not change measured RMS');
     await js(`document.querySelector('.measurement-response-reference-toggle input').click()`);await settle();
     for(const point of result.synthesis.mergedPoints){
      const values=point.segments.flatMap(s=>s.timeDomain.values).filter(v=>v!==null);
      assert(values.some(v=>v<0)&&values.some(v=>v>0),'Actual valid waveform retains both signs: '+point.radialPointName);
     }
     checks.push({signedRms:{negativeReferenceOnly:true,zeroPlane:true,togglePreservesMeasurements:true,allFivePointsRetainSignedWaveforms:true}});
    }
    const bands=result.synthesis.candidates.length?result.synthesis.candidates:result.synthesis.bandResponses;
    for(const p of initial){const value=bands[0].points.find(x=>x.radialPointId===p.id);assert.equal(p.amplitude,value.normalizedAmplitude);}
    if(bands.length>1){
     await js(`(()=>{const e=document.querySelector('select[aria-label="共同频带"]');e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();
     const changed=await markers();assert.notDeepEqual(changed,initial);
     for(const p of changed){const value=bands[1].points.find(x=>x.radialPointId===p.id);assert.equal(p.amplitude,value.normalizedAmplitude);}
     await js(`(()=>{const e=document.querySelector('select[aria-label="共同频带"]');e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();
    }
    const projection=await js(`document.querySelector('[data-response-interval]').getAttribute('points')`);
    await js(`(()=>{const e=document.querySelector('[aria-label="三维幅值水平视角"]');e.closest('details').open=true;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'45');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await settle();
    assert.notEqual(await js(`document.querySelector('[data-response-interval]').getAttribute('points')`),projection);
    assert.deepEqual(await markers(),initial,'Changing perspective must not alter measurement values');
    await click('复位视图');await js(`document.querySelector('.measurement-response-3d-settings').open=false`);await settle();
    checks.push({threeD:{markers:initial,bandSelection:true,viewChangePreservesMeasurements:true}});
   }
   for(const width of [1440,2821]){
    win.setContentSize(width,width===2821?1420:1050);await settle();await js("document.querySelector('.workspace').scrollTo(0,0)");await shot(`synthesis-${width}`);
    await js(`document.querySelector('[aria-label="叶根到叶尖多测点振幅合成"]').closest('.card').scrollIntoView({block:'start'})`);await shot(`synthesis-${width}-amplitude`);
    await js(`document.querySelector('[aria-label="多角度有效片段合成波形"]').closest('.measurement-charts').scrollIntoView({block:'start'})`);await shot(`synthesis-${width}-waveforms`);
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth+1'),false);
   }
   fs.writeFileSync(path.join(out,'real-synthesis-validation.json'),JSON.stringify(result,null,2));
   checks.push({synthesis:result.coverage,points:result.synthesis.mergedPoints.map(p=>({name:p.radialPointName,segments:p.segments.length,seconds:p.durationSeconds}))});
  }
  fs.writeFileSync(path.join(out,`${before?'before':'after'}-metrics.json`),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));
 }catch(e){console.error(e.stack);if(win)await shot('failure').catch(()=>{});process.exitCode=1;}
 finally{clearTimeout(timer);if(win)win.destroy();app.exit(process.exitCode||0);}
});
