"""Saved, typed modal datasets and immutable estimator results. No device access."""
from __future__ import annotations
import hashlib,json,time,uuid,zipfile,csv,io
from pathlib import Path
import numpy as np
from . import modal_engine as engine
from .reference.geometry import SignalError
from .reference.cli import json_safe
from .presentation import plot_indices
from ..storage import atomic_json

def _id(value):
 if not isinstance(value,str) or len(value)!=32 or any(c not in '0123456789abcdef' for c in value):raise SignalError('INVALID_MODAL_ID','Invalid saved modal identifier')
 return value

def dispatch(root,payload):
 folder=Path(root)/'formal-modal-v22';datasets=folder/'datasets';jobs=folder/'jobs';datasets.mkdir(parents=True,exist_ok=True);jobs.mkdir(exist_ok=True)
 action=payload.get('operation');p=payload.get('parameters') or {}
 if action=='capabilities':return engine.capabilities()
 if action=='from-segment':
  from .manager import RecordAnalysisManager
  base=Path(root);package=p.get('packageSha256')
  if package is not None:
   if not isinstance(package,str) or len(package)!=64 or any(c not in '0123456789abcdef' for c in package):raise SignalError('INVALID_MODAL_INPUT','Invalid package reference')
   base=base/'analysis-packages'/package
   if not (base/'verification.json').is_file():raise SignalError('INVALID_MODAL_INPUT','Package not verified')
  manager=RecordAnalysisManager(base)
  try:
   result=manager._load_segment(p.get('workerJobId'),p.get('resultId'));real=result.analysis_input()
   if result.status.get('analysis_state')!='ready' or not result.status.get('summary_eligible',True):raise SignalError('MODAL_QUALITY_REVIEW_REQUIRED','Review this real segment before modal estimation')
   a=p.get('startSeconds',0);b=p.get('endSeconds',len(real.time_s)/real.sample_rate_hz)
   if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and np.isfinite(v) for v in (a,b)) or not 0<=a<b<=len(real.time_s)/real.sample_rate_hz:raise SignalError('INVALID_MODAL_WINDOW','Select an independent interval inside the real analysis core')
   lo=int(np.ceil(a*real.sample_rate_hz)) if 'startSeconds' in p else 0;hi=int(np.floor(b*real.sample_rate_hz)) if 'endSeconds' in p else len(real.time_s);o=result.parameters['object']
   source=f'native_record:{real.recording_id}; source_sha256:{real.source_hash}; processed_layer:{result.layer}; SI_velocity_m_per_s; independent_calibration_not_verified'
   channel={'id':result.result_id,'pointId':p.get('pointId') or o.get('point'),'role':'response','quantity':'velocity','unit':'m/s','direction':result.basis,'calibrationSource':p.get('calibrationSource') or source,'calibrationStatus':'unverified','measurementSource':'native_record_metadata','values':real.values_m_s[lo:hi].tolist()}
   data={'schemaVersion':'modal-input-1','sourceKind':'native_record_segment','time_s':real.time_s[lo:hi].tolist(),'channels':[channel],'evidence':p.get('evidence') or {},'sourceReference':{'processingResultId':p.get('processingResultId'),'workerJobId':p['workerJobId'],'resultId':result.result_id,'sourceHash':real.source_hash,'sourceRange':[real.source_start+lo,real.source_start+hi],'layer':result.layer,'qualityRevision':result.parameters.get('quality_revision'),'filterEdges':[result.analysis_start,result.analysis_end]}}
  finally:manager.close()
  return dispatch(root,{'operation':'import','parameters':{'dataset':data,'name':p.get('name'),'context':p.get('context')}})
 if action=='import':
  data=p.get('dataset');engine.validate(data)
  if data.get('sourceKind') not in ('imported_measurement','native_record_segment'):raise SignalError('MODAL_SOURCE_REQUIRED','Production datasets must declare a measured source; validation fixtures do not enter health history')
  encoded=json.dumps(data,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()
  if len(encoded)>20*1024*1024:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','Modal JSON input exceeds 20 MiB; import a smaller continuous dataset')
  sha=hashlib.sha256(encoded).hexdigest();old=next((f for f in datasets.glob('*.json') if json.loads(f.read_text()).get('sourceSha256')==sha),None)
  if old:return json.loads(old.read_text())['summary']
  identity=uuid.uuid4().hex;t,y,fs,channels,_=engine.validate(data);meta={'id':identity,'sourceSha256':sha,'name':p.get('name') or identity,'samples':len(t),'sampleRateHz':fs,'durationSeconds':len(t)/fs,'channels':[{k:v for k,v in c.items() if k!='values'} for c in channels],'context':p.get('context'),'evidence':data.get('evidence'),'sourceReference':data.get('sourceReference'),'createdAt':time.time(),'sourceKind':data['sourceKind']}
  atomic_json(datasets/(identity+'.json'),{'sourceSha256':sha,'summary':meta,'data':data});return meta
 if action=='catalog':return {'datasets':[json.loads(f.read_text())['summary'] for f in datasets.glob('*.json') if not f.is_symlink()],'capabilities':engine.capabilities()}
 dataset_id=p.get('datasetId');job_id=p.get('jobId')
 if action=='start':
  path=datasets/(_id(dataset_id)+'.json')
  if path.is_symlink():raise SignalError('INVALID_MODAL_INPUT','Dataset links forbidden')
  saved=json.loads(path.read_text());jid=uuid.uuid4().hex;dest=jobs/jid;dest.mkdir();job={'id':jid,'datasetId':dataset_id,'method':p.get('method'),'sourceSha256':saved['sourceSha256'],'context':saved['summary'].get('context'),'algorithmVersion':engine.VERSION,'createdAt':time.time(),'status':'running'};atomic_json(dest/'job.json',job)
  try:
   result=engine.compute(saved['data'],p.get('method'));arrays={}
   def store(v,key='data'):
    if isinstance(v,np.ndarray):arrays[key]=v;return {'npz':key,'shape':list(v.shape)}
    if isinstance(v,dict):return {k:store(x,key+'__'+k) for k,x in v.items()}
    if isinstance(v,list):return [store(x,key+'__'+str(i)) for i,x in enumerate(v)]
    return v
   metadata=store(result);np.savez_compressed(dest/'evidence.npz',**arrays);atomic_json(dest/'result.json',json_safe(metadata,include_arrays=True));job.update(status='complete',finishedAt=time.time());atomic_json(dest/'job.json',job)
   return {'job':job,'result':plot_result(dest)}
  except Exception as e:
   job.update(status='failed',error=f'{getattr(e,"code",type(e).__name__)}: {e}');atomic_json(dest/'job.json',job);raise
 if action in ('result','export'):
  dest=jobs/_id(job_id)
  if dest.is_symlink():raise SignalError('INVALID_MODAL_ID','Result links forbidden')
  job=json.loads((dest/'job.json').read_text())
  if job['status']!='complete':raise SignalError('MODAL_RESULT_NOT_READY','Result is not complete')
  if action=='result':return {'job':job,'result':plot_result(dest)}
  name='模态参数识别_'+job_id[:8]+'.zip';output=dest/name
  with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
   for f in [dest/'job.json',dest/'result.json',dest/'evidence.npz']:z.write(f,f.name)
   saved=json.loads((datasets/(job['datasetId']+'.json')).read_text());summary=saved['summary'];z.writestr('input-provenance.json',json.dumps(summary,ensure_ascii=False));z.writestr('real-input.json',json.dumps(saved['data'],ensure_ascii=False))
   result=plot_result(dest);stream=io.StringIO();writer=csv.DictWriter(stream,fieldnames=['mode','naturalFrequencyHz','dampedFrequencyHz','dampingRatio','decayRatePerSecond','timeConstantSeconds','status'],extrasaction='ignore');writer.writeheader();writer.writerows({'mode':i+1,**m} for i,m in enumerate(result['modes']));z.writestr('modal-parameters.csv',stream.getvalue().encode('utf-8-sig'))
  return {'path':str(output.resolve()),'fileName':name,'mimeType':'application/zip'}
 raise SignalError('INVALID_MODAL_ACTION','Unsupported modal action')

def plot_result(directory):
 meta=json.loads((directory/'result.json').read_text())
 with np.load(directory/'evidence.npz',allow_pickle=False) as archive:
  def expand(v):
   if isinstance(v,dict) and 'npz' in v:return archive[v['npz']].copy()
   if isinstance(v,dict):return {k:expand(x) for k,x in v.items()}
   if isinstance(v,list):return [expand(x) for x in v]
   return v
  result=expand(meta)
 evidence=result['evidence'];pairs=[('time_s',['response','fittedResponse']),('frequencyHz',['frfReal','frfImag','frfMagnitude','coherence','forcePsd','responsePsd']),('fitFrequencyHz',['fitMagnitude'])]
 for x,ys in pairs:
  if x in evidence:
   fields=[k for k in ys if k in evidence];i=plot_indices(*(evidence[k] for k in fields),limit=2000)
   evidence[x]=evidence[x][i]
   for k in fields:evidence[k]=evidence[k][i]
   evidence[x+'_displaySourceIndices']=i
 result['displayReduction']='evidence plot only; full arrays remain in evidence.npz';return json_safe(result,include_arrays=True)
