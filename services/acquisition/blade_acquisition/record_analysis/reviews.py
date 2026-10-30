"""Immutable audit history. Reviews alter a derived plan, never raw samples."""
from __future__ import annotations
import json,time,uuid
from .reference.geometry import SignalError
from .reference.quality import candidate_window
from .plan import digest
from ..storage import atomic_json

def history(manager,rid):
 manager.load_recording(rid);folder=manager.root/'quality-reviews'/rid
 if folder.is_symlink():raise SignalError('INVALID_REVIEW','Review folder must not be a link')
 return sorted([json.loads(p.read_text()) for p in folder.glob('*.json') if not p.is_symlink()],key=lambda r:r['at'])
def current(manager,rid,revision=None):
 entries=history(manager,rid)
 if revision is not None:return next((r for r in entries if r['id']==revision),None)
 return entries[-1] if entries else None

def save(manager,body):
 allowed={'action','jobId','recordingId','intervals','reason','evidence','actor','operation','parentRevision'}
 if set(body)-allowed:raise SignalError('INVALID_REVIEW','Unknown review fields')
 rid=body.get('recordingId');raw=manager.load_recording(rid);report=manager.result({'jobId':body.get('jobId')})
 if rid not in [r['recording_id'] for r in report['records']]:raise SignalError('TASK_SCOPE_MISMATCH','Review must reference a source of this result')
 if not isinstance(body.get('reason'),str) or not body['reason'].strip() or not isinstance(body.get('actor'),str) or not body['actor'].strip():raise SignalError('INVALID_REVIEW','Reviewer and reason are required')
 if next(r for r in report['records'] if r['recording_id']==rid).get('source_hash')!=raw.source_hash:raise SignalError('SOURCE_CHANGED','Review source changed since processing')
 prior=current(manager,rid);parent=prior['id'] if prior else None
 if body.get('parentRevision')!=parent:raise SignalError('REVIEW_CONFLICT','Quality history changed; refresh before reviewing')
 intervals=body.get('intervals',[])
 if body.get('operation')=='undo':
  if not prior:raise SignalError('INVALID_REVIEW','No review to undo')
  previous=current(manager,rid,prior.get('parentRevision')) if prior.get('parentRevision') else None;intervals=previous['intervals'] if previous else []
 if not isinstance(intervals,list) or len(intervals)>100:raise SignalError('INVALID_REVIEW','Invalid review intervals')
 start,end=candidate_window(raw)
 for item in intervals:
  if not isinstance(item,dict) or set(item)!={'start','end','decision'} or item['decision'] not in ('include','exclude') or any(type(item[k]) is not int for k in ('start','end')) or not start<=item['start']<item['end']<=end:raise SignalError('INVALID_REVIEW','Review intervals must stay within the validated candidate clock')
 value={'id':uuid.uuid4().hex,'recordingId':rid,'parentRevision':parent,'sourceHash':raw.source_hash,'processingParent':body['jobId'],'actor':body['actor'],'at':time.time(),'reason':body['reason'].strip(),'evidence':body.get('evidence'),'intervals':intervals,'operation':body.get('operation','review')}
 value['version']=digest(value);folder=manager.root/'quality-reviews'/rid;folder.mkdir(parents=True,exist_ok=True);atomic_json(folder/(value['id']+'.json'),value)
 return {'review':value,'history':history(manager,rid),'requiresReprocessing':True}
