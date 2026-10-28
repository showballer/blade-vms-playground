'use strict';
// Isolated loopback acceptance using a copy of actual P3 samples. No device calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {randomUUID, randomBytes, scryptSync, createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/sync-alignment-20261027');
fs.mkdirSync(output, {recursive:true});
const mysql = require(root + '/node_modules/mysql2/promise');
const {createFieldCloudSync} = require(root + '/apps/desktop/electron/field-cloud-sync.cjs');
const origin = 'http://127.0.0.1:3210';
const source = path.resolve(process.env.BLADE_SYNC_TEST_NATIVE_DIR || path.join(root, 'artifacts/blade2-five-point-audit-20261027/imported-recordings/9b15dd0a183485febc7b8cb669075790'));
const originalId = path.basename(source);
assert.match(originalId, /^[a-f0-9]{32}$/);
assert(fs.existsSync(path.join(source, 'manifest.json')), 'Provide BLADE_SYNC_TEST_NATIVE_DIR with a complete measured native recording');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => Object.fromEntries(fs.readdirSync(source).sort().map(name => [name, hash(fs.readFileSync(path.join(source, name)))]));
const report = {passed: false, hardwareTested: false, actualHistoricalSamples: true, sourceRecordingId: originalId, rates: []};
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'blade-sync-native-audit-'));
const tenant = 'qa-sync-native-' + randomUUID(), userId = randomUUID();
let db, session, cloud, failure;
async function api(route, method='GET', body) {
  const response = await fetch(origin+'/api/v1/'+route, {method, headers: {'content-type':'application/json', ...(session ? {authorization:'Bearer '+session.token}: {})}, body: body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(120000)});
  const value = await response.json();
  assert.equal(response.status, 200, route+': '+String(value.error || response.status));
  return value;
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function main() {
  assert(['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST));
  assert.equal(process.env.DB_NAME, 'blade_vms_playground');
  const before = fingerprint();
  db = await mysql.createConnection({host:process.env.DB_HOST,port:+process.env.DB_PORT||3306,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  try {
    const username='qa-native-'+randomUUID(), password=randomBytes(24).toString('hex'), salt=randomBytes(16).toString('hex');
    await db.execute('INSERT INTO users(id,username,name,password_hash,role,tenant,active) VALUES(?,?,?,?,?,?,1)',[userId,username,'同步核验临时账号',salt+':'+scryptSync(password,salt,64).toString('hex'),'analyst',tenant]);
    session = await api('session','POST',{username,password});
    const context = {serverUrl:origin,user:session.user,token:session.token};
    for (const targetRate of [0,10000,50000,100000]) {
      const parent=path.join(temporary,String(targetRate)),dataDir=path.join(parent,'recordings');
      fs.mkdirSync(dataDir,{recursive:true});
      fs.cpSync(source,path.join(dataDir,originalId),{recursive:true});
      const prepared=[];
      cloud=createFieldCloudSync({file:path.join(parent,'queue.json'),dataDir,intervalMs:100,auth:{cloudBinding:()=>context,cloudSession:()=>context},getLive:()=>null,
        prepareUpload: async (id,rate) => {
          const result=JSON.parse(execFileSync(path.join(root,'services/acquisition/.venv/bin/python'),['-c',
            'import json,sys\nfrom pathlib import Path\nfrom blade_acquisition.storage import RecordingStore\nfrom blade_acquisition.upload_sampling import prepare_upload\ns=RecordingStore(Path(sys.argv[1]))\nprint(json.dumps(prepare_upload(s,sys.argv[2],int(sys.argv[3]),Path(sys.argv[4]))))',
            dataDir,id,String(rate),path.join(parent,'upload-cache')],{encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'services/acquisition')}}));
          prepared.push(result.recording); return result;
        },
        fetchImpl:(url,options)=>{assert.equal(new URL(url).origin,origin);return fetch(url,options);}
      });
      cloud.setEnabled(false);
      if(targetRate!==50000)cloud.setUploadSampleRate(targetRate); // Exercise the actual 50 kHz default.
      cloud.resume();cloud.uploadRecording(originalId);
      const deadline=Date.now()+120000;
      let item;
      while(Date.now()<deadline){
        item=cloud.status().items.find(x=>x.recordingId===originalId);
        if(item?.state==='error')throw Error('Upload: '+item.error);
        if(item?.state==='synced')break;
        await delay(100);
      }
      assert.equal(item?.state,'synced','Upload must complete');
      const beforeAdopt=await api('measurements');
      const rawSource=beforeAdopt.sources.find(s=>s.reference?.id===item.captureId || s.id===item.captureId || s.key==='capture:'+item.captureId);
      assert(rawSource,'Uploaded capture must be visible in measurement sources');
      assert(rawSource.context, 'New native capture must associate automatically without an adopt click');
      const live=(await api('measurements/live')).captures.find(c=>c.id===item.captureId);
      assert.deepEqual(live.context,rawSource.context,'Live and analysis use one binding');
      const archive=await api('captures/'+item.captureId+'/archive-preview');
      assert.equal(archive.origin,'archive');
      assert.equal(archive.frame.recording.sampleRate,targetRate||250000);
      assert.equal(archive.frame.waveform.sampleRate,targetRate||250000);
      assert(archive.frame.waveform.values.length || archive.frame.waveform.envelope.length);
      assert.equal(archive.frame.recording.pointCycle.handoff.sampleClock,'continuous_session_raw');
      await api('objects/adopt','POST',{});
      const afterAdopt=await api('measurements');
      const adopted=afterAdopt.sources.find(s=>s.reference?.id===item.captureId || s.id===item.captureId || s.key==='capture:'+item.captureId);
      assert(adopted.context,'Explicit adoption must populate context');
      const result=(await api('measurements/analyze','POST',{reference:{kind:'capture',id:item.captureId},parameters:{includeDiagnostic:true}})).result;
      const f=result.features;
      assert.equal(f.sampleRate,targetRate||250000);
      const originalManifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
      assert.equal(f.rawSamples,Math.ceil(originalManifest.samples*(targetRate||250000)/originalManifest.sampleRate));
      assert.equal(f.diagnosticOnly,true);assert.equal(f.validMeasurement,false);
      assert(f.validSeconds>0 && f.validSeconds<.15);
      const meta=prepared[0]||JSON.parse(fs.readFileSync(path.join(dataDir,originalId,'manifest.json'),'utf8'));
      report.rates.push({uploadRate:targetRate||250000,defaultRate:targetRate===50000,samples:f.rawSamples,validSamples:f.validSamples,validSeconds:f.validSeconds,ranges:f.ranges,boundaryBasis:f.boundaryBasis,diagnosticOnly:f.diagnosticOnly,sampling:meta.sampling||null,captureId:item.captureId,context:adopted.context,uploadComplete:true});
      fs.writeFileSync(path.join(output,'native-result-'+(targetRate||250000)+'.json'),JSON.stringify(result,null,2));
      console.log('PASS actual native -> desktop upload -> automatic association -> live/archive -> measurement analysis: '+f.sampleRate+' Hz, '+f.validSeconds+' s');
      cloud.dispose();await cloud.settled();cloud=null;
    }
    const original=report.rates[0];
    for(const row of report.rates){assert(Math.abs(row.validSeconds-original.validSeconds)<=1/row.uploadRate+.000001,'Duration must remain consistent within one target sample');}
    if (process.env.BLADE_SYNC_UI === '1') {
      const credentialFile = path.join(temporary, 'ui-session.json');
      fs.writeFileSync(credentialFile, JSON.stringify({username,password,origin,output}), {mode:0o600});
      const electronEnv = {...process.env}; delete electronEnv.ELECTRON_RUN_AS_NODE;
      execFileSync(require('electron'), [path.join(root,'scripts/measurement-sync-ui-smoke.cjs'),credentialFile], {env:electronEnv,stdio:'inherit',timeout:120000});
      report.uiVerified=true;
    }
    assert.deepEqual(fingerprint(),before,'Original historical record changed');
    report.originalUntouched=true;
  } catch(e) {failure=e; console.error(e.message);}
  finally {
    if(cloud){cloud.dispose();await cloud.settled();}
    try {
      const [caps]=await db.execute('SELECT id FROM captures WHERE owner_id=? AND tenant=?',[userId,tenant]);
      const captureRoot=path.resolve(process.env.BLADE_CAPTURE_DATA_DIR||path.join(root,'.data/web-captures'));
      for(const cap of caps){assert.match(cap.id,/^[a-f0-9]{32}$/);fs.rmSync(path.join(captureRoot,cap.id),{recursive:true,force:true});}
      await db.execute('DELETE FROM captures WHERE owner_id=? AND tenant=?',[userId,tenant]);
      await db.execute('DELETE FROM records WHERE tenant=?',[tenant]);
      await db.execute('DELETE FROM sync_imports WHERE user_id=? AND tenant=?',[userId,tenant]);
      await db.execute('DELETE FROM audit_logs WHERE tenant=?',[tenant]);
      await db.execute('DELETE FROM sessions WHERE user_id=?',[userId]);
      await db.execute('DELETE FROM users WHERE id=? AND tenant=?',[userId,tenant]);
      const analysisRoot=path.resolve(process.env.BLADE_ANALYSIS_DATA_DIR||path.join(root,'.data/web-rotation'));
      fs.rmSync(path.join(analysisRoot,hash(tenant+'\0'+userId)),{recursive:true,force:true});
      fs.rmSync(temporary,{recursive:true,force:true});
      report.qaCleaned=true;
    } catch(e) {failure ||= e;console.error('Cleanup: '+e.message);}
    await db.end();
    report.passed=!failure;report.error=failure?.message||null;
    fs.writeFileSync(path.join(output,'native-upload-verification.json'),JSON.stringify(report,null,2));
  }
  if(failure)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
