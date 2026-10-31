"""Evidence-aware segmentation before detrending. No fixed-length core crop."""
from __future__ import annotations
import numpy as np
from .plan import EDGE,digest
from .reference.quality import candidate_window,extract_segments,runs
from .pass_edges import exit_transitions

def assess(raw,config,review=None):
 start,end=candidate_window(raw);segments,hard=extract_segments(raw,config);events=list(hard);ranges=[];statistics=[]
 passinfo=(raw.manifest.get('pointCycle') or {}).get('handoff') or {}
 target_events=passinfo.get('passCompleteness')=='confirmed' and passinfo.get('entryConfirmedSampleIndex') is not None and passinfo.get('exitSampleIndex') is not None
 for seg in segments:
  y=seg.values_m_s;fs=seg.sample_rate_hz;w=max(4,int(round(EDGE['windowSeconds']*fs)));persist=max(2,int(np.ceil(EDGE['persistenceSeconds']*fs/w)))
  count=len(y)//w;lo,hi=seg.source_start,seg.source_end;cuts={lo,hi};states=[]
  # Saved pass events are clock-validated by candidate_window. Outside samples
  # support edge classification only; they never extend the analysis range.
  contextual=exit_transitions(raw,config,lo,hi) if target_events and hi==end else []
  for event in contextual:
   a,bound=event['source_start'],event['source_end'];cuts.update((a,bound));states.append((a,bound,'review'));events.append(event)
  if count>=2*persist+2:
   b=y[:count*w].reshape(count,w);med=np.median(b,axis=1);mad=np.median(abs(b-med[:,None]),axis=1)*1.4826
   d=abs(np.diff(med));noise=max(float(np.median(mad)),float(np.finfo(float).eps*max(1.,np.max(abs(y)))))
   typical=max(float(np.median(d)),noise/4);jumps=np.flatnonzero((d>EDGE['stepSigma']*noise)&(d>EDGE['stepDifferenceRatio']*typical))+1
   for j in jumps:
    # A short excursion returning to the prior level is a real-impact candidate,
    # not a persistent platform switch. It is never removed on amplitude alone.
    before=med[max(0,j-persist):j];after=med[j:min(count,j+persist)]
    if len(before)<2 or len(after)<2:continue
    before_level=float(np.median(before));after_level=float(np.median(after));shift=abs(after_level-before_level)
    if shift<EDGE['stepSigma']*noise:continue
    left_flat=np.ptp(before)<shift*.2;right_flat=np.ptp(after)<shift*.2
    if not (left_flat and right_flat):continue
    refine_start=max(0,(int(j)-1)*w);refine_end=min(len(y),(int(j)+1)*w)
    if any(lo+refine_start<e['transitionRange'][1] and lo+refine_end>e['transitionRange'][0] for e in contextual):continue
    # Refine the persistent level change, not the largest single derivative:
    # a later real impulse can have a sharper edge than the platform switch.
    local=y[refine_start:refine_end]
    cost_before=np.r_[0.,np.cumsum(abs(local-before_level))]
    cost_after=np.r_[np.cumsum(abs(local[::-1]-after_level))[::-1],0.]
    pos=lo+refine_start+int(np.argmin(cost_before+cost_after));left_dist=(pos-lo)/fs;right_dist=(hi-pos)/fs
    transition_start=lo+refine_start;transition_end=lo+refine_end
    # The sample-level split is an estimate. Keep the detector's two-window
    # uncertainty out of quantitative summaries; do not call it verified loss.
    a,bound=lo,transition_end
    side='entry'
    if right_dist<left_dist:a,bound=transition_start,hi;side='exit'
    near=min(left_dist,right_dist)<=EDGE['edgeProximitySeconds']
    verified=(raw.manifest.get('qualityRules') or {}).get('passBoundaryEvidenceVerified') is True
    state='excluded' if near and target_events and verified else 'review'
    if not near:
     a,bound=lo,hi
    cuts.update((a,bound,pos,transition_start,transition_end));states.append((a,bound,state))
    events.append({'code':'PASS_EDGE_TRANSITION' if state=='excluded' else 'PERSISTENT_PLATFORM_REVIEW','source_start':a,'source_end':bound,'excluded':state=='excluded','qualityState':state,'basis':'persistent_median_step+local_scatter+verified_pass_boundary' if state=='excluded' else 'statistics_only','side':side,'estimatedStepSample':pos,'transitionRange':[transition_start,transition_end],'refinement':EDGE['stepRefinement'],'levelChange_m_s':shift,'robustNoise_m_s':noise,'ruleVersion':EDGE['version']})
   drift=float(np.median(med[-persist:])-np.median(med[:persist]));monotonic=float(np.mean(np.sign(np.diff(med))==np.sign(drift)))
   if abs(drift)>EDGE['trendSigma']*noise and monotonic>EDGE['trendMonotonicFraction']:
    states.append((lo,hi,'review'));events.append({'code':'SLOW_BASELINE_REVIEW','source_start':lo,'source_end':hi,'qualityState':'review','excluded':False,'basis':'persistent_signed_baseline_drift_without_physical_motion_reference','drift_m_s':drift,'monotonicFraction':monotonic,'robustNoise_m_s':noise})
   # Exact freezes/zero tails are uncertain without independent device evidence.
   same=np.r_[False,np.isfinite(y[1:])&(y[1:]==y[:-1])]
   for a,bound in runs(same):
    a=max(0,a-1)
    if (bound-a)/fs<EDGE['frozenSeconds']:continue
    a,bound=lo+a,lo+bound;cuts.update((a,bound));states.append((a,bound,'review'))
    events.append({'code':'FROZEN_TARGET_UNKNOWN','source_start':a,'source_end':bound,'qualityState':'review','excluded':False,'basis':'exact_freeze_without_independent_target_evidence'})
   statistics.append({'sourceRange':[lo,hi],'windowSamples':w,'windowSeconds':w/fs,'persistenceWindows':persist,'robustNoise_m_s':noise,'stepCandidates':len(jumps)})
  points=sorted(cuts)
  for a,b in zip(points,points[1:]):
   if b-a<2:continue
   overlap=[state for x,z,state in states if x<b and z>a];state='excluded' if 'excluded' in overlap else 'review' if 'review' in overlap else 'auto_pass'
   ranges.append({'start':a,'end':b,'state':state})
 if review:
  for instruction in review.get('intervals',[]):
   a,b=instruction['start'],instruction['end'];new=[]
   for item in ranges:
    lo,hi=item['start'],item['end']
    for x,z in zip(sorted(set((lo,hi,max(lo,min(hi,a)),max(lo,min(hi,b))))),sorted(set((lo,hi,max(lo,min(hi,a)),max(lo,min(hi,b)))))[1:]):
     if x<z:new.append({'start':x,'end':z,'state':('reviewed_pass' if instruction['decision']=='include' else 'excluded') if a<=x and z<=b else item['state']})
   ranges=new
  events.append({'code':'QUALITY_REVIEW_APPLIED','source_start':start,'source_end':end,'qualityRevision':review['id'],'actor':review['actor'],'basis':review['reason'],'excluded':False})
 return {'candidateRange':[start,end],'ranges':ranges,'events':events,'statistics':statistics,'rule':dict(EDGE),'reviewRevision':review.get('id') if review else None,'version':digest([EDGE,review])}
