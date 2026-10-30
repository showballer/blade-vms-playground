'use strict';
const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
const owner=c=>c?JSON.stringify([c.serverUrl,c.user.id,c.user.tenant]):'';
// Separate persistent queue from raw-waveform uploads. A new account never owns
// the previous account's pending result packages; tokens are never persisted.
function createAnalysisSync({file,auth,prepare,enroll,fetchImpl=global.fetch,intervalMs=2000}){
 let items=[],working=false,disposed=false;try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw Error('无效结果同步队列');items=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(items)||items.length>500||items.some(i=>! /^[0-9a-f]{32}$/.test(i.jobId)||!['queued','waiting_dependencies','error','synced','uploading'].includes(i.state)||typeof i.owner!=='string'))throw Error('无效结果同步队列');for(const i of items)if(i.state==='uploading')i.state='queued';}catch(e){if(e.code!=='ENOENT')throw e;}
 function persist(){const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(items),{mode:0o600});fs.renameSync(temp,file);}
 const current=()=>auth.cloudSession();
 const status=()=>({items:items.filter(i=>i.owner===owner(current())).map(({jobId,state,error,resultId,progress,readBack})=>({jobId,state,error,resultId,progress,readBack})),running:working});
 async function run(){if(working||disposed)return;const ctx=current(),scope=owner(ctx);if(!ctx)return;const item=items.find(i=>i.owner===scope&&i.state!=='synced'&&(!i.retryAt||i.retryAt<Date.now()));if(!item)return;working=true;
  async function request(operation,body,extra={}){if(owner(current())!==scope)throw Error('统一账号绑定已变化；旧结果保留原账号队列');const url=new URL(ctx.serverUrl+'/api/v1/measurements/analysis-packages');url.searchParams.set('operation',operation);url.searchParams.set('sha256',item.package.sha256);if(extra.offset!==undefined)url.searchParams.set('offset',extra.offset);const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(180000),headers:{Authorization:'Bearer '+ctx.token,...(Buffer.isBuffer(body)?{'Content-Type':'application/octet-stream'}:{'Content-Type':'application/json'})},body:Buffer.isBuffer(body)?body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'结果上传失败'),{status:response.status});if(owner(current())!==scope)throw Error('账号已切换，保留原账号结果');return result.data??result;}
  try{
   item.state='uploading';item.error='';persist();item.package=await prepare(item.jobId);
   if(owner(current())!==scope)throw Error('Account binding changed during preparation');for(const id of item.package.recordingIds){if(owner(current())!==scope)throw Error('Account binding changed before source enrollment');await enroll(id);}
   const init=await request('init',{bytes:item.package.bytes,recordingIds:item.package.recordingIds});let offset=init.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>item.package.bytes)throw Error('服务端续传偏移无效');
   const handle=await fs.promises.open(item.package.path,'r');try{while(offset<item.package.bytes){const buffer=Buffer.alloc(Math.min(4*1024*1024,item.package.bytes-offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(bytesRead!==buffer.length)throw Error('结果包读取不完整');const r=await request('chunk',buffer,{offset});if(r.offset!==offset+bytesRead)throw Error('结果分块确认偏移不一致');offset=r.offset;item.progress=offset/item.package.bytes;persist();}}finally{await handle.close();}
   const r=await request('complete',{});if(r.status!=='verified')throw Error('服务端尚未确认结果复算');item.state='synced';item.resultId=r.id;item.readBack=r.readBack;item.progress=1;item.error='';item.finishedAt=Date.now();
  }catch(e){item.error=e.message;item.state=e.message.includes('waiting_dependencies')?'waiting_dependencies':'error';item.retryAt=Date.now()+(item.state==='waiting_dependencies'?4000:15000);}finally{persist();working=false;}
 }
 const timer=setInterval(()=>void run(),intervalMs);timer.unref?.();
 return {status,enqueue(jobId){const ctx=current();if(!ctx)throw Error('请先绑定并登录 Web 统一账号');let item=items.find(i=>i.jobId===jobId&&i.owner===owner(ctx));if(!item){if(items.length>=500)throw Error('结果同步历史达到500项，请先处理待上传结果');item={jobId,owner:owner(ctx),state:'queued',createdAt:Date.now()};items.push(item);}if(item.state!=='synced'){item.state='queued';item.retryAt=0;}persist();void run();return status();},dispose(){disposed=true;clearInterval(timer);}};
}
module.exports={createAnalysisSync};
