"""Portable immutable analysis results, with full native dependencies and recomputation.

Checksums prove byte integrity, not physical blade identity. Imported review
attribution is retained as client provenance and cannot approve health evidence.
"""
from __future__ import annotations
import hashlib,json,time,zipfile,shutil
from pathlib import Path,PurePosixPath
import numpy as np
from .adapter import source_fingerprint,record_files
from .plan import LIMITS,contract,digest
from .reference.geometry import SignalError

SCHEMA='blade-analysis-package-2.2'
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def create(manager,job_id):
 folder=manager._directory(job_id);job=manager.jobs[job_id];report=manager.result({'jobId':job_id})
 if not report.get('workspace') or report.get('processingContract')!=contract():raise SignalError('PACKAGE_LEGACY_READONLY','Recalculate legacy results with the current plan before uploading')
 files={};sources=job['policySources'];task=json.loads((folder/'task.json').read_text())
 for source in sources:
  rid=source['recordingId']
  if source_fingerprint(manager.recordings,rid)!=source:raise SignalError('SOURCE_CHANGED','Package source changed after processing')
  _,_,chunks=record_files(manager.recordings,rid)
  for f in [manager.recordings/rid/'manifest.json',*chunks]:files['recordings/'+rid+'/'+f.name]=f
 for f in folder.iterdir():
  if f.suffix in ('.npz','.json') and f.is_file() and not f.name.startswith(('preview-','extended-')):files['analysis/'+f.name]=f
 if sum(p.stat().st_size for p in files.values())>LIMITS['packageBytes']:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','Uncompressed package exceeds shared 256 MiB limit')
 manifest={'schemaVersion':SCHEMA,'contract':contract(),'task':task,'recordingIds':job['recordingIds'],'sourceFingerprints':sources,'workspace':job['workspace'],'scope':job['scope'],'profile':job['profile'],'config':job['config'],'reviews':job.get('qualityReviews',{}),'jobId':job_id,'files':{n:{'sha256':sha(p),'bytes':p.stat().st_size} for n,p in files.items()},'healthQualification':'not_promoted_by_package'}
 package_id=digest(manifest);out=folder/'exports';out.mkdir(exist_ok=True);target=out/('analysis-package-'+package_id+'.zip');temp=target.with_suffix('.part')
 with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
  z.writestr('package.json',json.dumps(manifest,ensure_ascii=False,allow_nan=False))
  for name,p in files.items():
   if p.is_symlink():raise SignalError('PACKAGE_PATH_INVALID','Links cannot enter packages')
   z.write(p,name)
 temp.replace(target)
 return {'packageId':package_id,'path':str(target.resolve()),'fileName':target.name,'bytes':target.stat().st_size,'sha256':sha(target),'recordingIds':[s['recordingId'] for s in sources],'schemaVersion':SCHEMA}

def unpack(package:Path,destination:Path,allowed_ids):
 if package.stat().st_size>LIMITS['packageBytes']:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','Package exceeds 256 MiB')
 with zipfile.ZipFile(package) as z:
  entries=z.infolist();names=[i.filename for i in entries]
  if len(entries)>20000 or len(set(names))!=len(names) or sum(i.file_size for i in entries)>LIMITS['packageBytes']:raise SignalError('PACKAGE_SIZE_INVALID','Invalid member count or decompressed size')
  if 'package.json' not in names or z.getinfo('package.json').file_size>4*1024*1024:raise SignalError('PACKAGE_INVALID','Bounded manifest required')
  m=json.loads(z.read('package.json'))
  if m.get('schemaVersion')!=SCHEMA or m.get('contract')!=contract():raise SignalError('PACKAGE_VERSION_UNSUPPORTED','Package uses another engine/plan version; keep read-only and recalculate explicitly')
  if set(m.get('task',{}).get('recordingIds',[]))-set(allowed_ids) or not set(m.get('recordingIds',[]))<=set(allowed_ids):raise SignalError('PACKAGE_DEPENDENCIES_MISSING','Upload and associate all native source records to this account first')
  if set(names)!={'package.json',*m.get('files',{})}:raise SignalError('PACKAGE_INVALID','Unexpected or missing dependency')
  for i in entries:
   p=PurePosixPath(i.filename)
   if p.is_absolute() or '..' in p.parts or '\\' in i.filename or len(p.parts)<1 or (i.external_attr>>16)&0o170000==0o120000:raise SignalError('PACKAGE_PATH_INVALID','Unsafe package member')
   if i.filename=='package.json':continue
   if not (p.parts[0]=='recordings' and len(p.parts)==3 and p.parts[1] in allowed_ids or p.parts[0]=='analysis' and len(p.parts)==2):raise SignalError('PACKAGE_PATH_INVALID','Unexpected member path')
   expected=m['files'][i.filename]
   if expected['bytes']!=i.file_size:raise SignalError('PACKAGE_CHECKSUM_MISMATCH','Member size mismatch')
   target=destination.joinpath(*p.parts);target.parent.mkdir(parents=True,exist_ok=True)
   with z.open(i) as r,target.open('xb') as w:shutil.copyfileobj(r,w,1024*1024)
   if sha(target)!=expected['sha256']:raise SignalError('PACKAGE_CHECKSUM_MISMATCH','Member SHA-256 mismatch')
 return m

def validate_server_sources(root,base,mapping):
 from .adapter import load_raw
 from ..upload_sampling import prepare_upload
 class Store:
  def directory(self,rid):return base/'recordings'/rid
  def _read_manifest(self,directory):return json.loads((directory/'manifest.json').read_text())
  def chunks(self,directory):return sorted(directory.glob('chunk-*.bin'))
 verified=[]
 for rid,server_id in mapping.items():
  expected=load_raw(Path(root)/'recordings',server_id);candidate=load_raw(base/'recordings',rid)
  if candidate.sample_rate_hz!=expected.sample_rate_hz:
   sampling=expected.manifest.get('sampling') or {}
   if sampling.get('kind')!='anti_alias_lowpass' or sampling.get('sourceSampleRate')!=candidate.sample_rate_hz or sampling.get('sourceSamples')!=len(candidate.time_s):raise SignalError('PACKAGE_SOURCE_MISMATCH','Server source does not declare this native sampling origin')
   derived=prepare_upload(Store(),rid,int(expected.sample_rate_hz),base/'dependency-check-cache');target=base/'dependency-check-records'/rid
   target.parent.mkdir(exist_ok=True)
   if not target.exists():shutil.copytree(derived['directory'],target)
   candidate=load_raw(target.parent,rid)
  if candidate.time_s.shape!=expected.time_s.shape or not np.array_equal(candidate.time_s,expected.time_s) or not np.array_equal(candidate.overrange,expected.overrange) or not np.array_equal(candidate.velocity_m_s,expected.velocity_m_s,equal_nan=True) or not np.allclose(candidate.rssi_percent,expected.rssi_percent,rtol=0,atol=1e-7,equal_nan=True):raise SignalError('PACKAGE_SOURCE_MISMATCH','Native source or its exact anti-alias derivative differs from the already authorized server waveform')
  for key in ('pointCycle','turntable','diagnosticOnly','validMeasurement','qualityIntervals','qualityRules'):
   actual=candidate.manifest.get(key);known=expected.manifest.get(key,(expected.manifest.get('sourceMetadata') or {}).get(key))
   if digest(actual)!=digest(known):raise SignalError('PACKAGE_SOURCE_METADATA_MISMATCH','Candidate boundaries, geometry or raw quality differ from authorized source metadata')
  verified.append({'nativeId':rid,'serverId':server_id,'serverSourceHash':expected.source_hash,'relation':'exact_native_or_recomputed_antialias_derivative'})
 return verified

def verify(root,package:Path,allowed_ids,server_sources=None):
 from .manager import RecordAnalysisManager
 from ..storage import atomic_json
 from ..web_signal import common_response
 from .reviews import history
 identity=sha(package);base=Path(root)/'analysis-packages'/identity;verified=base/'verification.json'
 if verified.is_file():
  old=json.loads(verified.read_text())
  if set(old['dependencyIds'])<=set(allowed_ids):
   if server_sources:validate_server_sources(root,base,server_sources)
   return old
  raise SignalError('PACKAGE_DEPENDENCIES_MISSING','Package dependencies no longer available')
 if base.exists():shutil.rmtree(base)
 base.mkdir(parents=True);m=unpack(package,base,allowed_ids)
 # Source identities and bounds are re-read from native files, not the plots.
 for expected in m['sourceFingerprints']:
  if source_fingerprint(base/'recordings',expected['recordingId'])!=expected:raise SignalError('PACKAGE_CHECKSUM_MISMATCH','Native dependency fingerprint mismatch')
 source_relations=validate_server_sources(root,base,server_sources) if server_sources else []
 manager=RecordAnalysisManager(base)
 task=m['task'];manager.catalog=lambda:{'tasks':[task]}
 try:
  for rid,review in m.get('reviews',{}).items():
   if rid not in task['recordingIds'] or review.get('recordingId')!=rid:raise SignalError('PACKAGE_REVIEW_INVALID','Review source mismatch')
   folder=manager.root/'quality-reviews'/rid;folder.mkdir(parents=True,exist_ok=True)
   # Imported attribution is unverified; retain the exact mathematical revision
   # for parity, but do not promote it to a server-approved health review.
   atomic_json(folder/(digest(review)+'.json'),review)
  job=manager.start({'taskId':task['id'],'recordingIds':m['recordingIds'],'workspace':{k:m['workspace'][k] for k in ('purpose','algorithmOptions')},'scope':m['scope'],'profile':m['profile'],'config':m['config']})
  until=time.monotonic()+150
  while manager.status(job['jobId'])['status'] in ('queued','running'):
   if time.monotonic()>until:raise SignalError('PACKAGE_VERIFY_TIMEOUT','Recomputation timed out')
   time.sleep(.02)
  if manager.status(job['jobId'])['status']!='complete':raise SignalError('PACKAGE_RECOMPUTE_FAILED',manager.status(job['jobId']).get('error') or 'Recompute failed')
  result=json.loads((manager._directory(job['jobId'])/'result.json').read_text());claimed=json.loads((base/'analysis/result.json').read_text())
  def equivalent(a,b):
   if isinstance(a,dict) and isinstance(b,dict):return set(a)==set(b) and all(equivalent(a[k],b[k]) for k in a if k!='jobId')
   if isinstance(a,list) and isinstance(b,list):return len(a)==len(b) and all(equivalent(x,y) for x,y in zip(a,b))
   if isinstance(a,(float,int)) and not isinstance(a,bool) and isinstance(b,(float,int)) and not isinstance(b,bool):return bool(np.isclose(a,b,rtol=1e-10,atol=1e-12,equal_nan=False))
   return a==b
  if not equivalent(result,claimed):raise SignalError('PACKAGE_RESULT_MISMATCH','Saved scalar results or source interval plan differ from recomputation')
  array_files=0
  for f in (base/'analysis').glob('*.npz'):
   with zipfile.ZipFile(f) as archive:
    if sum(v.file_size for v in archive.infolist())>LIMITS['packageBytes'] or len(archive.infolist())>1000:raise SignalError('PACKAGE_SIZE_INVALID','Oversized nested array archive')
   target=manager._directory(job['jobId'])/f.name
   if not target.is_file():raise SignalError('PACKAGE_RESULT_MISMATCH','Unknown or missing real segment')
   with np.load(f,allow_pickle=False) as old,np.load(target,allow_pickle=False) as new:
    if set(old.files)!=set(new.files) or any(old[k].shape!=new[k].shape or not np.allclose(old[k],new[k],rtol=1e-10,atol=1e-12,equal_nan=True) for k in old.files):raise SignalError('PACKAGE_ARRAY_MISMATCH','Full real arrays differ from recomputation')
   array_files+=1
  expected_arrays={s['result_id']+'.npz' for r in result['records'] for s in r['segments']}
  if expected_arrays!={f.name for f in (base/'analysis').glob('*.npz')}:raise SignalError('PACKAGE_RESULT_MISMATCH','Incomplete full real arrays')
  result.update(commonResponse=common_response(result,task),processingSource='desktop_verified',healthQualification='not_promoted_by_package',originalDesktopJobId=m['jobId'])
  response={'packageId':digest(m),'sha256':identity,'jobId':job['jobId'],'report':result,'task':task,'workspace':m['workspace'],'dependencyIds':task['recordingIds'],'selectedRecordingIds':m['recordingIds'],'verifiedArrays':array_files,'sourceRelations':source_relations,'verifiedAt':time.time(),'reviewAttribution':'client_provenance_only','rtol':1e-10,'atol':1e-12}
  atomic_json(verified,response);return response
 finally:manager.close()
