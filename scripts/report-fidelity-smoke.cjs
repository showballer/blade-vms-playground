// Exercise the actual product renderer and API, not a separately authored QA report.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),mysql=require('mysql2/promise'),{randomBytes,createHash}=require('node:crypto'),JSZip=require('jszip');
const {rotationCanonical}=require('../apps/desktop/electron/rotation-data.cjs'),{modalBaselineCanonical}=require('../apps/desktop/electron/modal-data.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/report-fidelity');process.loadEnvFile(path.join(root,'apps/web/.env.local'));
if(process.env.DB_NAME!=='blade_vms_playground')throw Error('Refusing non-project DB');fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(out,'profile-')));app.on('window-all-closed',()=>{});
const origin='http://127.0.0.1:3210',tenant='qa_report_'+Date.now(),password=randomBytes(18).toString('base64url'),users=[],tokens={},tests=[];let db,rootToken,win,failure;
async function api(p,method='GET',body,token=tokens.analyst){const r=await fetch(origin+'/api/v1/'+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw Error(p+': '+r.status+' '+data.error);return data;}
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(condition){const start=Date.now();while(Date.now()-start<12000){if(typeof condition==='string'?await js(condition):await condition())return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timeout: '+condition);}
const click=text=>until(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.scrollIntoView({block:'nearest'});b.click();return true;})()`);
async function field(label,value){await js(`(()=>{const el=[...document.querySelectorAll('input,textarea')].find(e=>e.closest('label')?.querySelector('span')?.textContent===${JSON.stringify(label)});if(!el)throw Error('Missing field');Object.getOwnPropertyDescriptor((el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement).prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
async function select(label,value){await js(`(()=>{const el=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!el)throw Error('Missing select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function load(role,name){if(win)win.destroy();win=new BrowserWindow({show:false,width:1366,height:768,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:tenant+role}});await win.webContents.session.cookies.set({url:origin,name:'blade_session',value:tokens[role],httpOnly:true,sameSite:'strict'});await win.loadURL(origin+'/#report');await until(`(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}));const b=row&&[...row.querySelectorAll('button')].find(b=>b.textContent==='加载');if(!b)return false;b.click();return true;})()`);await until('document.querySelector("#report-print h1")?.textContent==='+JSON.stringify(name));}
let lastDownload=0;
async function download(label,name){
  // Space user actions realistically; Chromium intentionally suppresses bursts of >10 downloads/second.
  const gap=500-(Date.now()-lastDownload);if(gap>0)await new Promise(r=>setTimeout(r,gap));
  const file=path.join(out,name);let finished=false;win.webContents.session.once('will-download',(_e,item)=>{item.setSavePath(file);item.once('done',(_e,state)=>{assert.equal(state,'completed');finished=true;});});await click(label);lastDownload=Date.now();await until(()=>finished);return fs.readFileSync(file);
}
async function capture(name){await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function check(name,fn){await fn();tests.push({name,result:'pass'});console.log('PASS '+name);}
app.whenReady().then(async()=>{const watchdog=setTimeout(()=>{console.error('Report fidelity timeout');app.exit(1);},60000);try{
  db=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});rootToken=(await api('session','POST',{username:'admin',password:process.env.BOOTSTRAP_PASSWORD},'')).token;
  for(const role of ['analyst','viewer']){const username=tenant+'_'+role,u=await api('users','POST',{username,password,name:'报告验收 '+role,tenant,role},rootToken);users.push(u.id);tokens[role]=(await api('session','POST',{username,password},'')).token;}
  const task=await api('records/tasks','POST',{name:'报告验收叶片任务',object:'QA 叶片',turbine:'QA-RPT-01',point:'P3 叶尖',direction:'径向',sampleRate:100,duration:3,rpm:15,blades:3,range:10,samples:Array.from({length:300},(_,i)=>Number(Math.sin(i/12).toFixed(6))),source:'demo',note:'原始工况说明',channels:[{no:1,type:'velocity',unit:'mm/s'}]});
  const dataset={schema:'blade-vms/dataset-v1',title:'FFT 频谱演示',columns:[{key:'frequency',label:'频率',unit:'Hz',type:'number'},{key:'value',label:'演示幅值',unit:'mm/s',type:'number'}],rows:Array.from({length:100},(_,i)=>[i/20,i===12?1.8:i===24?1.25:0.06]),metadata:{type:'fft',source:'demo',demo:true,note:'固定原型演示结果，不用于工程判断。'}};
  const fft=await api('records/analyses','POST',{name:'频谱参数与已保存曲线',taskId:task.id,type:'fft',parameters:{window:'Hann',nfft:4096,filter:'带通',low:.1,high:20,note:'长参数分页验收。'.repeat(70)},result:{dataset,note:dataset.metadata.note},source:'demo'});
  await api('records/analyses','POST',{name:'损伤位置参考值',taskId:task.id,type:'damage',parameters:{method:'原型示例'},result:{type:'演示位置结果',location:'叶尖',confidence:.83,note:'未运行算法'},source:'demo'});
  const storedTask=await api('records/tasks/'+task.id);
  const modal=await api('records/analyses','POST',{name:'模态三阶参数验收',taskId:task.id,type:'modal',source:'demo',parameters:{workflow:'modal-preview-v1',sourceRevision:hash(rotationCanonical(storedTask)),baselineRevision:hash(modalBaselineCanonical()),config:{test:'free',method:'峰值拾取',damping:'半功率带宽',points:['P1','P3'],activeOrder:2,baselineId:'prototype'}}});
  const sections=['对象信息','采集参数','原始波形','降噪与截取','FFT 频谱','包络与时频','模态参数','损伤识别','结论与建议'];
  const report=await api('records/reports','POST',{name:'旋转叶片报告版式验收',taskId:task.id,sections,organization:'内蒙古工业大学 报告验收',reportNumber:'QA-RPT-001',conclusion:'此样例验证已保存数据与报告的引用、分页和图表，不构成真实检测结论。',source:'demo'});
  await api('records/tasks/'+task.id,'PUT',{samples:Array(300).fill(99),sampleRate:200,note:'后来修改的工况'});await api('records/analyses/'+fft.id,'PUT',{parameters:{nfft:8192},result:{dataset:{...dataset,rows:dataset.rows.map(row=>[row[0],99])}}});
  await load('analyst',report.name);
  await check('历史预览与 Word 只读导出保留保存时的任务和频谱，不隐式重存',async()=>{
    assert.equal(await js('document.querySelectorAll("#report-print .report-figure svg").length'),2);assert.ok(await js('document.querySelector("#report-print").textContent.includes("4096")'));assert.ok(!await js('document.querySelector("#report-print").textContent.includes("8192")'));
    const before=await api('records/reports/'+report.id);const bytes=await download('导出 Word','saved.docx');const after=await api('records/reports/'+report.id);assert.deepEqual(after,before);
    const zip=await JSZip.loadAsync(bytes),xml=await zip.file('word/document.xml').async('string');assert.ok(xml.includes('4096'));assert.ok(!xml.includes('8192'));assert.ok(xml.includes('原始工况说明'));assert.equal(Object.keys(zip.files).filter(f=>/^word\/media\/.*\.png$/.test(f)).length,2);assert.ok(xml.includes('原始幅值 (mm/s)')||xml.includes('幅值（任务通道单位）'));await capture('saved-preview-1366');
  });
  await check('实际 Chromium PDF 输出全部章节、长参数和两张已保存数据图',async()=>{
    await js('document.fonts.ready.then(()=>true)');const pdf=await win.webContents.printToPDF({printBackground:true,preferCSSPageSize:true});assert.equal(pdf.subarray(0,5).toString(),'%PDF-');fs.writeFileSync(path.join(out,'saved.pdf'),pdf);assert.equal(await js('document.querySelectorAll("#report-print section").length'),9);
  });
  await check('报告数据五格式使用原始快照，分析与模态子结果也不读取后来修改的记录',async()=>{
    for(const format of ['csv','txt','xlsx','mat','json']){await select('导出报告数据格式',format);const bytes=await download('导出报告数据','wave.'+format);assert.ok(bytes.length>100);}
    const wave=JSON.parse(fs.readFileSync(path.join(out,'wave.json'),'utf8'));assert.equal(wave.metadata.task.sampleRate,100);assert.equal(wave.metadata.report.id,report.id);assert.deepEqual(wave.rows.map(r=>r[1]),task.samples);
    await select('报告数据',fft.id);const spectrum=JSON.parse(await download('导出报告数据','spectrum.json'));assert.deepEqual(spectrum.rows,dataset.rows);assert.equal(spectrum.metadata.analysis.parameters.nfft,4096);
    for(const key of Object.keys(modal.result.datasets)){await select('报告数据',modal.id+':'+key);const saved=JSON.parse(await download('导出报告数据','modal-'+key+'.json'));assert.deepEqual(saved.rows,modal.result.datasets[key].rows);assert.equal(saved.metadata.report.id,report.id);}
    assert.ok(await js('(()=>{const el=document.querySelector("select[aria-label=报告数据]");return el.getBoundingClientRect().right<=el.closest(".card").getBoundingClientRect().right})()'));await capture('snapshot-data-1366');
    const content=await js('document.querySelector("#report-print").textContent');assert.ok(content.includes('结果 / 位置：叶尖'));assert.ok(content.includes('三阶弯曲'));assert.ok(!content.includes('"confidence"'));fs.writeFileSync(path.join(out,'expected.json'),JSON.stringify({task,reportId:report.id,fft:dataset.rows,modal:modal.result.datasets},null,2));
  });
  await check('编辑报告说明保留旧数据快照，任务已改变也不替换历史矩阵',async()=>{
    await field('报告标题','旋转叶片报告修改说明验收');await click('保存报告');await until(async()=> (await api('records/reports/'+report.id)).name==='旋转叶片报告修改说明验收');const edited=await api('records/reports/'+report.id);assert.deepEqual(edited.taskSnapshot,report.taskSnapshot);assert.deepEqual(edited.analysisSnapshots,report.analysisSnapshots);assert.equal(edited.generatedAt,report.generatedAt);assert.ok(edited.editedAt);
    assert.ok(await js('document.querySelector("#report-print").textContent.includes("4096")'));
  });
  await check('访客可从历史预览导出 Word，无需保存权限且不修改报告',async()=>{
    await load('viewer','旋转叶片报告修改说明验收');assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="导出 Word").disabled'),false);const before=await api('records/reports/'+report.id);await download('导出 Word','viewer.docx');assert.deepEqual(await api('records/reports/'+report.id),before);
  });
  await check('明确选择当前数据新建才使用新的任务和分析，原报告继续保留',async()=>{
    await load('analyst','旋转叶片报告修改说明验收');await click('用当前数据新建');await until('document.querySelector("#report-print").textContent.includes("8192")');await field('报告标题','当前数据新报告验收');await click('保存报告');await until(async()=> (await api('records/reports')).some(r=>r.name==='当前数据新报告验收'));const fresh=(await api('records/reports')).find(r=>r.name==='当前数据新报告验收');assert.notEqual(fresh.id,report.id);assert.equal(fresh.taskSnapshot.sampleRate,200);assert.equal((await api('records/reports/'+report.id)).taskSnapshot.sampleRate,100);await download('导出 Word','current.docx');await capture('current-preview-1366');
  });
  await check('伪造报告快照或更换历史源任务被忽略或拒绝，源记录删除后仍可导出原快照',async()=>{
    await api('records/reports/'+report.id,'PUT',{taskSnapshot:{samples:[666]},analysisSnapshots:[],author:'伪造编制',generatedAt:'2000-01-01',operatorRestricted:false});const saved=await api('records/reports/'+report.id);assert.deepEqual(saved.taskSnapshot,report.taskSnapshot);assert.deepEqual(saved.analysisSnapshots,report.analysisSnapshots);assert.equal(saved.author,report.author);assert.equal(saved.generatedAt,report.generatedAt);
    await assert.rejects(api('records/reports/'+report.id,'PUT',{taskId:'not-the-source'}),/400/);
    await api('records/analyses/'+fft.id,'DELETE');await api('records/tasks/'+task.id,'DELETE');await load('viewer','旋转叶片报告修改说明验收');await select('导出报告数据格式','json');const bytes=await download('导出报告数据','deleted-source-wave.json');assert.deepEqual(JSON.parse(bytes).rows.map(r=>r[1]),task.samples);await download('导出 Word','deleted-source.docx');
  });
}catch(e){failure=e;console.error(e);if(win)await capture('failure').catch(()=>{});}finally{if(win)win.destroy();if(db){await db.execute('DELETE FROM records WHERE tenant=?',[tenant]);for(const id of users){await db.execute('DELETE FROM sessions WHERE user_id=?',[id]);await db.execute('DELETE FROM users WHERE id=? AND tenant=?',[id,tenant]);}await db.end();}if(rootToken)await api('session','DELETE',undefined,rootToken).catch(()=>{});clearTimeout(watchdog);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({time:new Date().toISOString(),tests,error:failure?.message,renderReview:'Requires separate page PNG review',cleanup:'Only QA tenant records/users; audit retained'},null,2));app.exit(failure?1:0);}});
