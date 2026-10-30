"""Authorized Web adapter for the shared reference pipeline; no device/Electron access."""
from __future__ import annotations
import copy,hashlib,json,time
from dataclasses import replace
from pathlib import Path
from .record_analysis.manager import RecordAnalysisManager,geometry_comparison
from .record_analysis.adapter import load_raw,source_fingerprint,ID
from .sample_clock import continuous_sample_window


def normalized_manifest(manifest, recording_id, count, sample_rate_hz, binding=None):
    m=copy.deepcopy(manifest)
    metadata=m.get('sourceMetadata') or {}
    for key in ('pointCycle','turntable','windFarm','turbine'):
        if key not in m and key in metadata:m[key]=copy.deepcopy(metadata[key])
    pc=m.get('pointCycle') or {};m['pointCycle']=pc
    original=copy.deepcopy(pc)
    clock=pc.get('continuousSession') or {};handoff=pc.get('handoff') or {}
    if m.get('sampling',{}).get('pointCycleIndexMapping'):
        offset,count,up,down=continuous_sample_window(pc,m,count)
        for key in ('entrySampleIndex','entryConfirmedSampleIndex','exitSampleIndex','exitConfirmedSampleIndex'):
            value=handoff.get(key)
            if isinstance(value,int) and not isinstance(value,bool):
                mapped=((value-offset)*up+down-1)//down
                handoff[key]=min(-1,mapped) if value<offset else max(count+1,mapped) if value>offset+count else mapped
        handoff['sampleClock']='recording_local'
        pc['continuousSession']={**clock,'sampleClock':'recording_local','sampleStart':0,'sampleEndExclusive':count,'sampleRate':sample_rate_hz}
        pc['handoff']=handoff
        m['physicalCaptureId']=m.get('sourceRecordingId') or recording_id
    elif not clock and handoff.get('sampleClock') in ('recording_local','stationary_raw','recording_raw'):
        pc['continuousSession']={'sampleClock':handoff['sampleClock'],'sampleStart':0,'sampleEndExclusive':count}
    # Bindings are server-resolved object labels, never editable geometry or quality flags.
    if binding:
        m['windFarm']=binding['windFarm'];m['turbine']=binding['turbine']
        pc['bladeId']=binding['bladeId'];pc['radialPointName']=binding['pointName']
        m['applicationBinding']={**binding,'originalPointCycle':original}
    return m


def normalized_record(root, recording_id, binding):
    raw=load_raw(root,recording_id)
    return replace(raw,manifest=normalized_manifest(raw.manifest,recording_id,len(raw.time_s),raw.sample_rate_hz,binding))


class WebSignalManager(RecordAnalysisManager):
    def __init__(self,root,task=None,bindings=None):
        self.web_task=task;self.bindings=bindings or {}
        super().__init__(root)
    def catalog(self):
        if self.web_task is None:return super().catalog()
        return {'tasks':[self.web_task],'revision':self.web_task['id']}
    def load_recording(self,rid):
        return normalized_record(self.recordings,rid,self.bindings.get(rid))
    def compare_geometry(self,bundle,manifest):
        value=geometry_comparison(bundle,manifest)
        # Per-station D and angle are physical inputs, not object identity. LOS
        # results remain descriptive; axial results retain explicit assumptions.
        cfg=bundle['segments'][0].parameters['config'] if bundle.get('segments') else {}
        source=((manifest.get('turntable') or {}).get('config') or {}).get('geometry') or {}
        key={'coordinateConvention':cfg.get('allow_upright_geometry_assumption'),
             'sign':cfg.get('instrument_sign'),'projection':cfg.get('projection'),
             'rotationDirection':source.get('rotationDirection'),'axis1Sign':source.get('axis1Sign'),'axis2Sign':source.get('axis2Sign'),
             'pitchScale':source.get('pitchAngleScale'),'yawScale':source.get('yawAngleScale'),
             'binding':(manifest.get('applicationBinding') or {}).get('compositionMode')}
        value['geometryComparisonKey']=hashlib.sha256(json.dumps(key,sort_keys=True).encode()).hexdigest()
        value['geometryComparisonSnapshot']['perStationGeometryRetained']=True
        return value


def common_response(report, task):
    """Equal azimuth weighting on the intersection; never invent a missing point."""
    groups=[]
    for blade in sorted(set(str(r.get('bladeId')) for r in task['records'])):
        planned={r.get('pointName'):r.get('radiusM') for r in task['records'] if str(r.get('bladeId'))==blade}
        for layer in sorted(set(g.get('layer','') for g in report.get('aggregates',[]))):
            candidates={}
            for name in planned:
                items=[g for g in report['aggregates'] if str(g.get('blade'))==blade and g.get('point')==name and g.get('layer')==layer]
                candidates[name]=items[0] if len(items)==1 else None
            sets=[set(a['azimuth_deg'] for a in g.get('azimuth_results',[])) if g else set() for g in candidates.values()]
            angles=sorted(set.intersection(*sets)) if sets else []
            points=[]
            for name,radius in sorted(planned.items()):
                g=candidates[name]; values=[a for a in g.get('azimuth_results',[]) if a['azimuth_deg'] in angles] if g else []
                points.append({'point':name,'radiusM':radius,'mean_half_peak_to_peak_m_s':sum(a['mean_half_peak_to_peak_m_s'] for a in values)/len(values) if values else None,
                    'mean_segment_rms_m_s':sum(a['mean_segment_rms_m_s'] for a in values)/len(values) if values else None,
                    'resultIds':[rid for a in values for rid in a.get('result_ids',[])]})
            groups.append({'blade':blade,'layer':layer,'azimuths':angles,'weighting':'equal_azimuth','points':points,
                'phaseAvailable':False,'metric':'mean_half_peak_to_peak_m_s','unit':'m/s'})
    return groups

def dispatch(root:Path,payload:dict):
    operation=payload.get('operation');params=payload.get('parameters') or {}
    if operation=='fingerprints':
        ids=params.get('recordingIds')
        if not isinstance(ids,list) or not 1<=len(ids)<=64 or any(not isinstance(i,str) or not ID.fullmatch(i) for i in ids):raise ValueError('Invalid source selection')
        return {'sources':[source_fingerprint(root/'recordings',i) for i in ids]}
    if operation=='capabilities':return {'formalModalAvailable':False,'methods':[],
        'reasons':['未配置经过验证的正式模态算法','需要符合所选方法的同步相位、激励或参考数据'],
        'signalProfiles':['LOS_DIAGNOSTIC','RAW_REVIEW'],'derivedPackageProfiles':[],
        'phaseRecoveryAvailable':False,'healthCertificationAvailable':False}
    if operation=='process':
        ids=params.get('recordingIds');bindings=params.get('bindings');task=params.get('task')
        if not isinstance(ids,list) or not 1<=len(ids)<=64 or len(set(ids))!=len(ids) or any(not isinstance(i,str) or not ID.fullmatch(i) for i in ids):raise ValueError('请选择1～64份已授权原始记录')
        if not isinstance(bindings,dict) or set(bindings)!=set(ids) or not isinstance(task,dict) or task.get('recordingIds')!=ids:raise ValueError('来源绑定清单不完整')
        manager=WebSignalManager(root,task,bindings)
        try:
            job=manager.start({'taskId':task['id'],'recordingIds':ids,'scope':params.get('scope','analysis'),
                'profile':params.get('profile','LOS_DIAGNOSTIC'),'config':params.get('config',{})})
            until=time.monotonic()+150
            while manager.status(job['jobId'])['status'] in ('queued','running'):
                if time.monotonic()>until:raise ValueError('处理超时，请缩小来源范围')
                time.sleep(.02)
            if manager.status(job['jobId'])['status']!='complete':raise ValueError(manager.status(job['jobId']).get('error') or '处理未完成')
            result=manager.result({'jobId':job['jobId']})
            result['webBindingSnapshot']=bindings
            result['commonResponse']=common_response(result,task)
            result['processingSource']='Web重算'
            result['formalModal']={'available':False,'reason':'缺少已验证算法及符合方法要求的输入'}
            return result
        finally:manager.close()
    if operation not in ('result','extended','preview','export','waveforms'):raise ValueError('不支持的信号分析动作')
    manager=WebSignalManager(root)
    try:
        if operation=='waveforms':
            report=manager.result({'jobId':params.get('jobId')});curves=[]
            for record in report['records']:
                if not record.get('quality_assessment',{}).get('analysis_eligible') or not record.get('representative'):continue
                detail=manager.result({'jobId':params['jobId'],'recordingId':record['recording_id'],'segmentId':record['representative']})['detail']
                for segment in detail['segments']:
                    curves.append({'recordingId':record['recording_id'],'object':record['object'],'resultId':segment['result_id'],
                        'time_s':segment['time_s'],'velocity_m_s':segment['layers'].get('los_residual',[]),
                        'source_start':segment['source_start'],'source_end':segment['source_end'],'layer':'los_residual'})
            return {'jobId':params['jobId'],'curves':curves,'synthetic':False,'continuity':'discontinuous_segments','phaseAvailable':False}
        return getattr(manager,operation)(params)
    finally:manager.close()
