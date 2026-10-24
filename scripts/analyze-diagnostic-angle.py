"""Read-only replay of diagnostic entry windows and three-station handoff timings.

Run with the acquisition venv; this script never connects to field devices.
"""
import argparse
import json, datetime, statistics, sys
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services/acquisition'))
from blade_acquisition.storage import HEADER, RECORD_DTYPE
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--field-data', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--before', default='2026-10-24', help='Exclusive local-date upper bound, Asia/Shanghai')
args=parser.parse_args()
root=args.field_data
out=args.output
out.mkdir(parents=True, exist_ok=True)
cutoff=datetime.datetime.fromisoformat(args.before).replace(tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()
all_records=[]
for p in (root/'recordings').glob('*/manifest.json'):
 try:
  m=json.loads(p.read_text());pc=m.get('pointCycle')or{}
  if pc.get('stationCount')==3 and m.get('status')=='complete' and m.get('startedAt',cutoff)<cutoff:all_records.append(m)
 except (ValueError,OSError):pass
records=sorted(all_records,key=lambda x:x['startedAt'])
def diag(m):return (m['pointCycle'].get('diagnosticDetection')or{}).get('angleGateEnabled') is False
def tod(t):return datetime.datetime.fromtimestamp(t,ZoneInfo('Asia/Shanghai')).strftime('%m-%d %H:%M:%S')
latest=[m for m in records if diag(m)][-21:]
if not latest:
 raise SystemExit('No completed unlimited-angle three-station diagnostic records before cutoff')
normal=[m for m in records if not m.get('diagnosticOnly') and m['startedAt']<latest[0]['startedAt']][-21:]
def metrics(m):
 pc=m['pointCycle'];h=pc.get('handoff')or{};mv=h.get('completedMove')or{};ev=mv.get('events')or[]
 if not ev:return None
 def event(name):return next((v['seconds'] for v in ev if v['phase']==name),None)
 wire=event('wire_sending');ack=event('command_accepted');arr=event('arrived')
 if None in (wire,ack,arr):return None
 positions=[e for e in ev if e['phase']=='position_sample'];near=[e for e in positions if all(abs(a-b)<=.5 for a,b in zip(e['angles'],mv['targets']))];zero=[e for e in near if all(rpm==0 for rpm in e['motorRpm'])]
 first=next((p['seconds'] for p in positions if any(abs(a-b)>.05 for a,b in zip(p['angles'],mv['startAngles']))),None)
 de=pc.get('diagnosticDetection')or{};trig=de.get('trigger')or{}
 def delta(a,b):return a-b if a is not None and b is not None else None
 return dict(id=m['id'],time=tod(m['startedAt']),point=m['point'],next=h.get('nextPoint'),diagnostic=diag(m),sampleSeconds=m['samples']/m['sampleRate'],
  distanceDeg=[b-a for a,b in zip(mv['startAngles'],mv['targets'])],speedRpm=mv.get('speedLimitRpm'),
  detectToCommand=delta(h.get('motionCommandAt'),h.get('detectedAt')),observeToCommand=delta(h.get('motionCommandAt'),h.get('observedAt')),
  ackSeconds=ack-wire,boardPrepareMs=mv.get('boardPrepareMs'),commandToArrival=arr-wire,commandToFirstObserved=delta(first,wire),
  commandToNear=delta(near[0]['seconds'] if near else None,wire),nearToArrival=delta(arr,near[0]['seconds'] if near else None),
  commandToZero=delta(zero[0]['seconds'] if zero else None,wire),detectToArrival=delta(h.get('arrivedAt'),h.get('detectedAt')),
  firstMotion=mv.get('firstMotionSeconds'),rawId=(pc.get('continuousSession')or{}).get('id'),
  early=trig.get('detectedBeforeStoppedArrival'),atFence=trig.get('entrySampleIndex')==de.get('bufferFence') if trig else None)
rows=[v for m in latest+normal if (v:=metrics(m))]

def load_raw(rid):
 d=root/'continuous-sessions'/rid;m=json.loads((d/'manifest.json').read_text())
 arrays=[np.fromfile(p,dtype=RECORD_DTYPE,offset=HEADER.size) for p in sorted(d.glob('chunk-*.bin'))]
 return m,np.concatenate(arrays)
def signal_stats(v,flags):
 if not len(v):return None
 centered=v-np.median(v)
 return dict(samples=len(v),medianMps=float(np.median(v)),rmsAC=float(np.sqrt(np.mean(centered**2))),p95AbsAC=float(np.percentile(abs(centered),95)),peakToPeak=float(np.ptp(v)),overrangeFraction=float(np.mean((flags&1)!=0)),nearRangeFraction=float(np.mean(abs(v)>=.98)))
features=[];cache={}
for m in normal+latest:
 pc=m['pointCycle'];ref=pc.get('continuousSession')or{};rid=ref.get('id')
 if not rid:continue
 if rid not in cache:
  cache.clear();cache[rid]=load_raw(rid)
 raw,arr=cache[rid];h=(pc.get('diagnosticDetection')or{}).get('trigger') if diag(m) else pc.get('handoff');h=h or{}
 if h.get('entrySampleIndex') is None:continue
 entry=h['entrySampleIndex'];end=h.get('exitSampleIndex',h.get('exitConfirmedSampleIndex'))
 if end is None:continue
 if not diag(m):entry+=ref['sampleStart'];end+=ref['sampleStart']
 a=arr[max(0,entry):min(len(arr),end)]
 # raw records use a continuous sample clock; keep both time bases visible.
 stop=(pc.get('diagnosticDetection')or{}).get('stopConfirmedAt')
 approximate_stop_index=int((stop-raw['sampleOrigin'])*raw['sampleRate']) if stop else None
 before=max(0,min(end,approximate_stop_index)-entry)/(end-entry) if approximate_stop_index is not None and end>entry else None
 features.append(dict(id=m['id'],time=tod(m['startedAt']),point=m['point'],diagnostic=diag(m),rawId=rid,entry=entry,end=end,duration=(end-entry)/raw['sampleRate'],stationStart=ref.get('sampleStart'),preStationFraction=max(0,min(end,ref['sampleStart'])-entry)/(end-entry),
  estimatedPreStopFraction=before,estimateNote='sampleOrigin is host-derived, not synchronized controller time',atFence=(pc.get('diagnosticDetection')or{}).get('bufferFence')==entry if diag(m) else None,
  velocity=signal_stats(a['velocity'],a['flags']),rssiMedian=float(np.median(a['rssi'])) if len(a) else None))
summary={}
for group in ['diagnostic','normal']:
 for hop in ['0°','120°']:
  selected=[r for r in rows if r['diagnostic']==(group=='diagnostic') and r['point'].endswith('· '+hop)]
  if not selected:continue
  stat={}
  for k in ['observeToCommand','ackSeconds','commandToArrival','commandToNear','nearToArrival','detectToArrival']:
   v=[r[k] for r in selected if r[k] is not None];stat[k]=dict(min=min(v),median=statistics.median(v),max=max(v))if v else None
  summary[group+' '+hop]=dict(n=len(selected),**stat)
result=dict(cutoff=args.before,timezone='Asia/Shanghai',records=[dict(id=m['id'],time=tod(m['startedAt']),point=m['point'],diagnostic=diag(m),samples=m['samples']) for m in latest+normal],moves=rows,features=features,summary=summary)
(out/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(summary,indent=2))
for x in rows:
 if x['diagnostic']:print(x['time'],x['point'],'->',x['next'],'delta',np.round(x['distanceDeg'],2),'send',round(x['observeToCommand'],3),'ack',round(x['ackSeconds'],3),'move',round(x['commandToArrival'],3),'near-stop',round(x['nearToArrival'],3)if x['nearToArrival'] is not None else None)
for g in [False,True]:
 s=[f for f in features if f['diagnostic']==g];print('signals',g,'n',len(s),'atFence',sum(bool(f['atFence']) for f in s),'medianDur',statistics.median(f['duration'] for f in s),'medianRms',statistics.median(f['velocity']['rmsAC'] for f in s),'preStation',statistics.median(f['preStationFraction'] for f in s))
