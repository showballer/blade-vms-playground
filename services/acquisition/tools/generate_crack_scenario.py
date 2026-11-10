"""Reproducible, isolated crack-response scenario; not a calibrated crack model."""
from __future__ import annotations
import copy
import csv
import gzip
import hashlib
import html
import io
import json
from pathlib import Path
import sys
import zipfile

import numpy as np
from scipy import signal

from blade_acquisition.record_analysis.adapter import load_raw
from blade_acquisition.storage import HEADER, MAGIC, RECORD_DTYPE, atomic_json
from blade_acquisition.web_signal import dispatch

VERSION = 'r025-crack-response-scenario-1'
# Engineering assumptions, fixed before comparison. Not fitted to a target damage label.
GAIN = [1.00, 1.12, 1.60, 1.75, 1.85]
RATIO = [1.00, .97, .92, .92, .94]
MODULATION = [0., .03, .16, .13, .10]


def synthesize(values, fs, point, rng, damaged):
    """Preserve a segment's linear background; transform only its residual."""
    x = np.asarray(values, dtype=float)
    residual = signal.detrend(x, type='linear')
    background = x-residual
    rms = float(np.sqrt(np.mean(residual**2)))
    if not damaged:
        # Tiny deterministic perturbation; no new independent healthy evidence.
        return background + residual * (1.003 if point % 2 else .997) + rng.normal(0, rms*.0001, len(x))
    p = point-1
    n = len(x)
    coordinate = np.arange(n, dtype=float)
    # An affine time dilation about the centre, entirely inside the observed support.
    warped = np.interp((n-1)/2 + RATIO[p]*(coordinate-(n-1)/2), coordinate, residual)
    phase = np.unwrap(np.angle(signal.hilbert(warped)))
    envelope = np.abs(signal.hilbert(warped))
    # Phenomenological opening/closing modulation and second harmonic component.
    modified = warped*(1+MODULATION[p]*np.sin(2*np.pi*coordinate/max(16, n/2)))
    modified += MODULATION[p]*.4*envelope*np.sin(2*phase+.37)
    # Local, smooth damped bursts; no one-sample spikes or sensor overflow fabrication.
    if point >= 3 and n >= 64:
        for centre in (.32*n, .68*n):
            z=(coordinate-centre)/max(8., .045*n)
            modified += rms*.65*np.exp(-.5*z*z)*np.sin(2*np.pi*z*2)
    modified = signal.detrend(modified, type='linear')
    return background + GAIN[p]*modified + rng.normal(0, rms*.0005, n)


def small_curve(t, x, limit=900):
    # Preserve extrema per bucket for plotting only; computation uses full samples.
    if len(x) <= limit:
        return t, x
    edges=np.linspace(0,len(x),limit//2+1,dtype=int)
    indices={0,len(x)-1}
    for a,b in zip(edges,edges[1:]):
        if b>a:
            indices.update((a+int(np.argmin(x[a:b])),a+int(np.argmax(x[a:b]))))
    i=np.array(sorted(indices));return t[i],x[i]


def chart(x, a, b, xlabel, ylabel):
    xmin,xmax=float(x.min()),float(x.max());ymin=min(float(a.min()),float(b.min()));ymax=max(float(a.max()),float(b.max()))
    if ymax<=ymin:ymax=ymin+1
    def points(y):
        tx,yy=small_curve(x,y)
        return ' '.join(f'{55+580*(t-xmin)/max(xmax-xmin,1e-12):.2f},{175-145*(v-ymin)/(ymax-ymin):.2f}' for t,v in zip(tx,yy))
    return f'<svg viewBox="0 0 660 215" role="img" aria-label="{html.escape(ylabel)}"><path d="M55 20V175H635" fill="none" stroke="#64748b"/><polyline points="{points(a)}" fill="none" stroke="#94a3b8" stroke-width="1"/><polyline points="{points(b)}" fill="none" stroke="#0891b2" stroke-width="1"/><g font-size="12" fill="#475569"><text x="55" y="194">{xmin:.3g}</text><text x="590" y="194">{xmax:.3g}</text><text x="6" y="35">{ymax:.3g}</text><text x="6" y="175">{ymin:.3g}</text><text x="270" y="212">{xlabel}</text><text x="55" y="14">{ylabel}</text></g></svg>'


def main(output):
    plan=json.loads((output/'runtime-input.json').read_text())
    native=output/'analysis-runtime';(native/'recordings').mkdir(parents=True,exist_ok=True)
    export=output/'分段数据';export.mkdir(exist_ok=True)
    analysis=output/'analysis';analysis.mkdir(exist_ok=True)
    provenance=[];cards=[];package_entries=[]
    epoch=1794272400.  # 2026-11-10 09:00 +08:00; explicitly a scenario clock.
    sequence=0
    for source in sorted(plan['sources'],key=lambda s:s['blade']):
        blade=source['blade'];ids=[];records=[];bindings={};mapping={}
        for rec in sorted(source['records'],key=lambda r:(r['point'],r['angle'])):
            raw=load_raw(Path(source['sourceRoot'])/'recordings',rec['id'])
            p=int(rec['point'][1:]);damaged=blade=='2'
            seed=int(hashlib.sha256(f'{VERSION}:{blade}:{p}:{rec["angle"]}'.encode()).hexdigest()[:16],16)
            rng=np.random.default_rng(seed);values=raw.velocity_m_s.copy()
            representative=next(s for s in rec['segments'] if s['resultId']==rec['representative'])
            spans=sorted(set((s['start'],s['end']) for s in rec['segments'] if s['layer']==representative['layer'] and s['basis']==representative['basis']))
            end_previous=-1
            for start,end in spans:
                if start<end_previous:raise ValueError('Overlapping source segments')
                if end-start>=4:values[start:end]=synthesize(values[start:end],raw.sample_rate_hz,p,rng,damaged)
                end_previous=end
            rid=hashlib.sha256(f'{VERSION}:{rec["sourceHash"]}:{blade}'.encode()).hexdigest()[:32]
            mapping[rec['id']]=rid;ids.append(rid)
            origin=epoch+sequence*2;sequence+=1
            assumption={'dataOrigin':'synthetic','generator':VERSION,'baselineTurbine':'R024','scenarioTurbine':'R025','baselineProcessingId':source['processingId'],'baselineRecordingId':rec['id'],'baselineSourceHash':rec['sourceHash'],'seed':seed,'scenarioClock':'constructed_not_measured','hypothesis':'crack_near_P3' if damaged else 'healthy_control_derived','assumedCrackType':'breathing_crack' if damaged else None,'crackSize':None,'velocityGain':GAIN[p-1] if damaged else (1.003 if p%2 else .997),'responseFrequencyRatio':RATIO[p-1] if damaged else 1.,'modulationDepth':MODULATION[p-1] if damaged else 0.,'segments':spans,'fieldDamageConfirmed':False}
            pc=copy.deepcopy(raw.manifest.get('pointCycle') or {});pc.update(collectionId=VERSION,bladeId=blade,radialPointName=rec['point'],radiusM=rec['radiusM'],azimuthDeg=rec['angle'],identityVerified=False)
            clock=raw.manifest.get('outdoorSegment',{}).get('sourceClock') or {}
            header={'format':'BladeVMS-split-segment-v1','name':'武川风场-R025-裂纹情景合成-第一组','source':'simulation','simulation':assumption,'windFarm':raw.manifest.get('windFarm','武川风场'),'turbine':'R025','point':rec['point'],'radiusM':rec['radiusM'],'pointCycle':pc,'sampleRate':raw.sample_rate_hz,'samples':len(values),'unit':'m/s','sourceSampleStart':0,'sourceSampleEndExclusive':len(values),'sourceSampleOrigin':origin,'diagnosticOnly':True,'validMeasurement':False,'identityVerified':False}
            original_header=raw.manifest.get('importSource',{}).get('originalHeader',{})
            source_start=original_header.get('sourceSampleStart',0)
            header.update(sourceSampleStart=source_start,sourceSampleEndExclusive=source_start+len(values),sourceSampleOrigin=origin-source_start/raw.sample_rate_hz)
            if original_header.get('segmentation'):header['segmentation']=copy.deepcopy(original_header['segmentation'])
            name=f'P{p}/{blade}号叶片_{rec["angle"]:g}度_裂纹情景合成.csv.gz'
            buffer=io.StringIO();buffer.write('# BladeVMS '+json.dumps(header,ensure_ascii=False,separators=(',',':'))+'\n')
            writer=csv.writer(buffer,lineterminator='\n');writer.writerow(['local_time_s','source_time_s','source_sample_index','velocity_m_s','RSSI_percent','overrange'])
            for i in range(len(values)):
                writer.writerow([f'{raw.time_s[i]-raw.time_s[0]:.12g}',f'{(source_start+i)/raw.sample_rate_hz:.12g}',source_start+i,repr(float(values[i])),repr(float(raw.rssi_percent[i])),int(raw.overrange[i])])
            blob=gzip.compress(buffer.getvalue().encode('utf-8'),mtime=0)
            destination=export/name;destination.parent.mkdir(exist_ok=True);destination.write_bytes(blob);package_entries.append(destination)
            manifest={k:copy.deepcopy(raw.manifest[k]) for k in ('turntable','rpm','measurementInputs','qualityIntervals','qualityRules') if k in raw.manifest}
            manifest.update(id=rid,name=header['name'],source='simulation',simulation=assumption,windFarm=header['windFarm'],turbine='R025',object='风机叶片',point=rec['point'],pointCycle=pc,measurementMode='outdoor',sampleRate=raw.sample_rate_hz,samples=len(values),sampleOrigin=origin,startedAt=origin,endedAt=origin+len(values)/raw.sample_rate_hz,status='complete',unit='m/s',rssiUnit='%',rssiSampleStride=1,rssiSampleRate=raw.sample_rate_hz,chunks=1,diagnosticOnly=True,validMeasurement=False,importSource={'originalHeader':header,'fileName':name,'sha256':hashlib.sha256(blob).hexdigest()},outdoorSegment={'schema':header['format'],'rawFile':'split-source.csv.gz','sourceClock':{'sourceEpoch':origin,'sourceSampleStart':0,'sampleRate':raw.sample_rate_hz}})
            location=native/'recordings'/rid;location.mkdir(exist_ok=True)
            native_data=np.zeros(len(values),dtype=RECORD_DTYPE);native_data['index']=np.arange(len(values));native_data['velocity']=values;native_data['rssi']=raw.rssi_percent;native_data['flags']=np.where(np.isfinite(raw.rssi_percent),2,0)|np.where(raw.overrange!=0,1,0)
            (location/'chunk-00000000.bin').write_bytes(HEADER.pack(MAGIC,raw.sample_rate_hz,origin,0)+native_data.tobytes());(location/'split-source.csv.gz').write_bytes(blob);atomic_json(location/'manifest.json',manifest)
            provenance.append({'file':name,'sha256':hashlib.sha256(blob).hexdigest(),'recordingId':rid,'blade':blade,'point':rec['point'],'angle':rec['angle'],'radiusM':rec['radiusM'],'sampleRate':raw.sample_rate_hz,'samples':len(values),**assumption})
            records.append({'id':rid,'bladeId':blade,'pointName':rec['point'],'radiusM':rec['radiusM'],'azimuthDeg':rec['angle'],'samples':len(values),'sampleRate':raw.sample_rate_hz,'createdAt':origin*1000})
            bindings[rid]={'windFarm':header['windFarm'],'turbine':'R025','bladeId':blade,'pointName':rec['point'],'sourceRecordingId':rid,'context':{'scenario':VERSION}}
            a,b=representative['start'],representative['end'];before=signal.detrend(raw.velocity_m_s[a:b]);after=signal.detrend(values[a:b]);t=np.arange(b-a)/raw.sample_rate_hz
            freq=np.fft.rfftfreq(len(before),1/raw.sample_rate_hz);window=np.hanning(len(before));fa=np.abs(np.fft.rfft(before*window))*2/max(window.sum(),1);fb=np.abs(np.fft.rfft(after*window))*2/max(window.sum(),1);mask=(freq>=100)&(freq<=20000)
            cards.append(f'<article><h3>叶片 {blade} · P{p} · {rec["angle"]:g}° · {"裂纹假设" if damaged else "健康对照派生"}</h3>'+chart(t,before,after,'Time (s)','Residual velocity (m/s)')+chart(freq[mask],fa[mask],fb[mask],'Frequency (Hz)','FFT peak amplitude (m/s)')+'</article>')
        workspace=copy.deepcopy(source['workspace']);workspace.pop('automaticPlan',None);workspace.pop('version',None)
        overrides=workspace['algorithmOptions'].get('geometry',{}).get('recordOverrides',{})
        if overrides:workspace['algorithmOptions']['geometry']['recordOverrides']={mapping[k]:v for k,v in overrides.items() if k in mapping}
        task={'id':hashlib.sha256(f'{VERSION}:{blade}'.encode()).hexdigest()[:32],'name':header['name'],'measurementMode':'outdoor','windFarm':header['windFarm'],'turbine':'R025','recordingIds':ids,'records':records}
        report=dispatch(native,{'operation':'process','parameters':{'recordingIds':ids,'bindings':bindings,'task':task,'scope':'analysis','profile':'LOS_DIAGNOSTIC','workspace':workspace}})
        (analysis/f'blade-{blade}.json').write_text(json.dumps(report,ensure_ascii=False,allow_nan=False))
        print(f'Analysed synthetic blade {blade}: {len(report["records"])} records',flush=True)
    manifest={'dataOrigin':'synthetic','generator':VERSION,'name':header['name'],'referenceStandardId':plan['standard']['id'],'referenceStandardName':plan['standard']['name'],'scenarioTruth':{'1':'healthy_control_derived','2':'assumed_crack_near_P3','3':'healthy_control_derived'},'fieldInspectionEvidence':None,'records':provenance}
    (output/'数据来源与生成参数.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>R025 裂纹情景合成数据</title><style>body{font-family:system-ui;max-width:1500px;margin:32px auto;padding:0 20px;color:#183047;background:#f3f6fa}header,article{background:white;padding:20px;border-radius:12px;margin-bottom:16px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:16px}svg{width:100%}p{line-height:1.7}a{color:#06758d}select{font:inherit;padding:8px}</style><header><h1>R025 · 裂纹情景合成数据</h1><p>60条记录，3片叶片 × 5测点 × 4角度。灰色为 R024 健康源记录，蓝色为情景合成记录。叶片2假设P3附近存在开闭裂纹；叶片1、3为派生健康对照。这些是软件测试数据，不能代替R025现场测量或裂纹确诊。</p><p>比较的是去线性趋势后的代表连续段及其 Hann 窗 FFT。频谱峰是响应峰，不是已识别的固有频率。全部分析使用完整采样；图形仅保极值降采样。</p><p><a href="数据来源与生成参数.json">来源与参数</a> · <a href="健康包络数值对照.csv">300项指标对照</a> · <a href="使用说明.md">使用说明</a></p><label>筛选叶片 <select onchange="document.querySelectorAll(\'article\').forEach(a=>a.hidden=this.value!==\'all\'&&!a.textContent.startsWith(\'叶片 \'+this.value))"><option value="all">全部</option><option>1</option><option selected>2</option><option>3</option></select></label></header><main>'+''.join(cards)+'</main><script>document.querySelector("select").dispatchEvent(new Event("change"));</script></html>'
    (output/'波形频谱预览.html').write_text(page)
    with zipfile.ZipFile(output/'R025_裂纹情景合成_桌面端导入.zip','w',compression=zipfile.ZIP_STORED) as z:
        for f in package_entries:z.write(f,f.relative_to(export).as_posix())
        z.write(output/'数据来源与生成参数.json','数据来源与生成参数.json')


def package(output):
    # Explicit allowlist: no runtime paths, database inputs, native cache or accounts.
    files=[output/name for name in ('数据来源与生成参数.json','使用说明.md','生成结果.md','健康包络数值对照.csv','健康包络数值对照.json','波形频谱预览.html')]
    files+=sorted((output/'分段数据').rglob('*.csv.gz'))
    with zipfile.ZipFile(output/'R025_裂纹情景合成_完整交付.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for f in files:z.write(f,f.relative_to(output).as_posix())
    with zipfile.ZipFile(output/'R025_裂纹情景合成_桌面端导入.zip','a',compression=zipfile.ZIP_DEFLATED) as z:
        if '使用说明.md' not in z.namelist():z.write(output/'使用说明.md','使用说明.md')


if __name__=='__main__':
    if sys.argv[1]=='--package-only':package(Path(sys.argv[2]).resolve())
    else:main(Path(sys.argv[1]).resolve())
