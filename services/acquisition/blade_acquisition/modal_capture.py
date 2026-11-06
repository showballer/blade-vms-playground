"""Synchronous modal acquisition lifecycle; device drivers are explicit, never simulated.

A configured driver implements run(plan, ready, samples, stop_event). See
 docs/modal-capture-driver.md. Test drivers are only injected into isolated tests.
"""
from __future__ import annotations
import copy, hashlib, importlib, json, math, os, threading, time, uuid
from pathlib import Path
import numpy as np
from .storage import atomic_json
from .record_analysis.modal_store import dispatch

ACTIVE = {'connecting', 'acquiring', 'stopping', 'saving'}
UNITS = {'force': 'N', 'velocity': 'm/s', 'displacement': 'm', 'acceleration': 'm/s^2'}


def validate_plan(value):
    if not isinstance(value, dict): raise ValueError('采集配置必须是对象')
    p=copy.deepcopy(value)
    if p.get('method') not in ('frf','ssi_cov'): raise ValueError('请选择 FRF 或 SSI-COV 同步采集方式')
    for key in ('name','deviceId','boundary','excitation'):
        if not isinstance(p.get(key),str) or not 1<=len(p[key].strip())<=500: raise ValueError('请填写任务、采集设备、边界条件及激励方式')
        p[key]=p[key].strip()
    fs=p.get('sampleRateHz');duration=p.get('durationSeconds')
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (fs,duration)) or not 10<=fs<=20000 or not 1<=duration<=7200:
        raise ValueError('采样率需为 10～20000 Hz，采集时长需为 1～7200 秒')
    channels=p.get('channels')
    if not isinstance(channels,list) or not 2<=len(channels)<=16: raise ValueError('同步采集需要 2～16 个通道')
    for c in channels:
        if not isinstance(c,dict): raise ValueError('无效通道配置')
        for key in ('id','hardwareChannel','pointId','direction','calibrationSource'):
            if not isinstance(c.get(key),str) or not 1<=len(c[key].strip())<=500: raise ValueError('请填写硬件通道、测点、方向和标定依据')
            c[key]=c[key].strip()
        if c['direction']=='unknown':raise ValueError('请填写已知的测量方向')
        if c.get('quantity') not in UNITS: raise ValueError('请选择通道物理量')
        c['unit']=UNITS[c['quantity']];c['role']='excitation' if c['quantity']=='force' else 'response'
        scale=c.get('scaleToSI')
        if isinstance(scale,bool) or not isinstance(scale,(int,float)) or not math.isfinite(scale) or scale<=0: raise ValueError('通道 SI 换算系数需为正数')
    if len({c['id'] for c in channels})!=len(channels) or len({c['hardwareChannel'] for c in channels})!=len(channels): raise ValueError('通道标识与硬件通道不能重复')
    force=[c for c in channels if c['role']=='excitation'];response=[c for c in channels if c['role']=='response']
    if p['method']=='frf' and (len(force)!=1 or len(response)!=1): raise ValueError('FRF 需要一个力通道和一个响应通道')
    if p['method']=='ssi_cov' and (force or len({c['quantity'] for c in response})!=1 or len({c['pointId'] for c in response})!=len(response)):
        raise ValueError('SSI 需要不同测点、相同物理量的同步响应通道')
    if p.get('conditionsConfirmed') is not True: raise ValueError('请确认试验条件与通道连接')
    # Bound JSON storage before touching hardware; do not silently truncate a run.
    p['targetSamples']=int(math.ceil(fs*duration))
    if p['targetSamples']*(len(channels)+1)>700000: raise ValueError('本批次数据量过大，请降低采样率、时长或通道数（最多70万个通道值）')
    return p


class ModalCaptureController:
    def __init__(self, root, receiver_factory=None, device_busy=lambda: False):
        self.root=Path(root);self.folder=self.root/'modal-captures';self.folder.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock();self.thread=None;self.stop_event=threading.Event();self.receiver_factory=receiver_factory
        self.device_busy=device_busy;self.driver_error='';self.current={'state':'idle','samples':0};self.preview=[]
        configured=os.environ.get('BLADE_MODAL_DRIVER','')
        if receiver_factory is None and configured:
            try:
                module,attribute=configured.split(':');self.receiver_factory=getattr(importlib.import_module(module),attribute)
            except Exception as exc:self.driver_error=f'同步采集驱动加载失败：{exc}'
        # Interrupted raw streams remain recoverable and never become completed datasets.
        for path in self.folder.glob('*/session.json'):
            if path.parent.is_symlink() or path.is_symlink():continue
            try:
                saved=json.loads(path.read_text())
                if saved.get('state') in ACTIVE:
                    saved.update(state='error',error='服务重启，采集未完成；原始接收数据保留。');atomic_json(path,saved)
            except (OSError,ValueError):pass

    def capabilities(self):
        return {'driverConfigured':self.receiver_factory is not None,'deviceState':'可连接' if self.receiver_factory else '未接入同步采集器',
                'message':self.driver_error or ('' if self.receiver_factory else '尚未接入多通道同步采集驱动；配置可以保留，连接设备后即可开始采集。')}

    def active(self):
        with self.lock:return self.current['state'] in ACTIVE

    def status(self):
        with self.lock:
            return {**copy.deepcopy(self.current),'capabilities':self.capabilities(),'preview':copy.deepcopy(self.preview[-400:])}

    def _update(self,**fields):
        with self.lock:
            self.current.update(fields)
            if self.current.get('id'):atomic_json(self.folder/self.current['id']/'session.json',self.current)

    def start(self, parameters):
        p=validate_plan(parameters)
        with self.lock:
            if self.active() or self.thread and self.thread.is_alive() or self.device_busy(): raise BlockingIOError('已有采集正在进行，请先停止并保存')
            if self.receiver_factory is None: raise ValueError(self.capabilities()['message'])
            sid=uuid.uuid4().hex;(self.folder/sid).mkdir();self.preview=[];self.stop_event=threading.Event()
            self.current={'id':sid,'state':'connecting','samples':0,'startedAt':time.time(),'plan':p,'error':None,'dataset':None}
            self._update();self.thread=threading.Thread(target=self._run,args=(sid,p,self.stop_event),name='modal-synchronous-capture',daemon=True);self.thread.start()
        return self.status()

    def _run(self,sid,p,stop):
        chunks=[];ready_info=None;count=0;fs=p['sampleRateHz'];nch=len(p['channels'])
        folder=self.folder/sid
        try:
            receiver=self.receiver_factory()
            def ready(info):
                nonlocal ready_info
                if ready_info is not None:raise ValueError('设备重复报告采样时钟，不能合并采集会话')
                if not isinstance(info,dict) or info.get('synchronization')!='common_sample_clock' or not isinstance(info.get('clockSource'),str) or not info['clockSource'].strip() or not isinstance(info.get('sampleRateHz'),(int,float)) or not math.isclose(info['sampleRateHz'],fs,rel_tol=1e-6):
                    raise ValueError('设备未确认公共采样时钟，或实际采样率与配置不符')
                if info.get('channelIds')!=[c['id'] for c in p['channels']]:raise ValueError('设备返回通道顺序与配置不符')
                ready_info=copy.deepcopy(info);self._update(state='acquiring',clock=ready_info)
            with (folder/'received.jsonl').open('x',encoding='utf-8') as raw:
                def samples(start_sample,values):
                    nonlocal count
                    if ready_info is None:raise ValueError('设备尚未确认同步采样，不能接收数据')
                    if stop.is_set():return
                    a=np.asarray(values,dtype=float)
                    if isinstance(start_sample,bool) or not isinstance(start_sample,int) or start_sample!=count or a.ndim!=2 or a.shape[1]!=nch or not 1<=len(a)<=8192 or not np.all(np.isfinite(a)):
                        raise ValueError('通道长度、连续样本序号或数值异常，不能保存为完整模态批次')
                    remaining=p['targetSamples']-count;a=a[:remaining]
                    raw.write(json.dumps({'startSample':count,'values':a.tolist()},allow_nan=False)+'\n');raw.flush()
                    scaled=a*np.array([c['scaleToSI'] for c in p['channels']]);chunks.append(scaled)
                    with self.lock:
                        stride=max(1,len(a)//80)
                        self.preview=(self.preview+[{'time_s':(count+i)/fs,'values':scaled[i].tolist()} for i in range(0,len(a),stride)])[-400:]
                    count+=len(a);self._update(samples=count)
                    if count>=p['targetSamples']:stop.set()
                receiver.run(copy.deepcopy(p),ready,samples,stop)
            if ready_info is None:raise ValueError('设备未就绪，采集未开始')
            if count<p['targetSamples'] and not stop.is_set():raise ValueError('设备流提前中断，记录未完整保存')
            if count<32:raise ValueError('有效同步样本不足32点，原始接收数据保留，未生成分析批次')
            self._update(state='saving');y=np.concatenate(chunks)
            channels=[{**{k:v for k,v in c.items() if k not in ('scaleToSI',)},'values':y[:,i].tolist()} for i,c in enumerate(p['channels'])]
            data={'schemaVersion':'modal-input-1','sourceKind':'native_record_segment','time_s':(np.arange(count)/fs).tolist(),'channels':channels,
                  'evidence':{'synchronization':'common_sample_clock','clockSource':ready_info['clockSource'],
                    'ambientExcitationAssumption':p['method']=='ssi_cov','excitationAssumptionSource':p['excitation'] if p['method']=='ssi_cov' else '',
                    'boundaryConditions':p['boundary'],'excitationDescription':p['excitation']},
                  'sourceReference':{'modalCaptureId':sid,'method':p['method'],'deviceId':p['deviceId'],'rawFile':'received.jsonl','rawSha256':hashlib.sha256((folder/'received.jsonl').read_bytes()).hexdigest(),'requestedSamples':p['targetSamples'],'receivedSamples':count,'stoppedEarly':count<p['targetSamples'],'channelScalesToSI':[c['scaleToSI'] for c in p['channels']]}}
            saved=dispatch(self.root,{'operation':'import','parameters':{'dataset':data,'name':p['name'],'context':p.get('context',{})}})
            self._update(state='complete',dataset=saved,finishedAt=time.time())
        except Exception as exc:self._update(state='error',error=str(exc),finishedAt=time.time())

    def stop(self, sid):
        with self.lock:
            if not self.current.get('id') or sid!=self.current['id']:raise ValueError('采集会话已变化，请刷新后再停止')
            if self.current['state'] in ('connecting','acquiring'):
                self.stop_event.set();self._update(state='stopping')
        return self.status()

    def close(self):
        with self.lock:self.stop_event.set();thread=self.thread
        if thread:thread.join(timeout=5)
