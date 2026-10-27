"""Quantitative spectra of real continuous pieces; smoothing is a display product.

Never FFT the cross-faded display, infer phase across visits, or label a spectral
peak as a structural mode. Every result retains source sample boundaries/hash.
"""
from __future__ import annotations
import math
import re
import numpy as np
from scipy.signal import welch, find_peaks
from .blade_passes import _raw, _range, _diagnostic, _preprocess, _metrics, _statistics, _merge_statistics, _time_curve

VERSION = "measurement-welch-1.2.0"


def _numeric(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name}须在 {low}～{high} 范围内")
    return value


def transient_events(pieces, rate, *, window_ms=20, rms_ratio=4, sigma=6):
    """Localize response bursts inside real pieces; never across an acquisition gap.

    The score is an RMS ratio, not a damage probability. A short or mostly
    abnormal piece has no reliable local reference and produces no event.
    """
    window=max(8,round(rate*window_ms/1000))
    events=[]; offset=0
    for part,values in enumerate(pieces):
        count=len(values)//window
        if count >= 8:
            envelope=np.sqrt(np.mean(values[:count*window].reshape(count,window)**2,axis=1))
            median=float(np.median(envelope)); mad=float(np.median(np.abs(envelope-median)))*1.4826
            threshold=max(median*rms_ratio, median+sigma*mad, 1e-12)
            high=envelope>threshold
            # A reference dominated by the excursion cannot support localization.
            if high.sum() <= count*.35:
                spans=np.flatnonzero(np.diff(np.r_[False,high,False].astype(np.int8))).reshape(-1,2)
                for a,b in spans:
                    start,end=int(a*window),int(b*window)
                    events.append({"id":f"burst-{part}-{start}","type":"response_burst","label":"局部振幅突增", "pieceIndex":part,
                        "pieceStartSample":start,"pieceEndSample":end,"startSeconds":(offset+start)/rate,"endSeconds":(offset+end)/rate,
                        "peakRmsMps":float(max(envelope[a:b])),"referenceRmsMps":median,"thresholdRmsMps":threshold,
                        "rmsRatio":float(max(envelope[a:b])/max(median,1e-12)),"confidence":None,"status":"review",
                        "rule":f"连续有效段内 {window_ms:g}ms RMS > max({rms_ratio:g}倍中位数, 中位数+{sigma:g}倍稳健标准差)",
                        "reason":"异常响应候选，需结合回波、工况及原始波形复核，不表示结构损伤确诊"})
        offset+=len(values)
    return events[:100]


def attach_event_sources(result, ranges, rate):
    for event in result.get("events",[]):
        source=ranges[event["pieceIndex"]]
        event["sourceRecordingId"]=source.get("recordingId",result.get("recordingId"))
        event["sourceStartSample"]=source["start"]+event["pieceStartSample"]
        event["sourceEndSample"]=source["start"]+event["pieceEndSample"]
        event["sourceStartSeconds"]=event["sourceStartSample"]/rate
        event["sourceEndSeconds"]=event["sourceEndSample"]/rate


def signal_features(pieces, rate, *, window_seconds=.25, fade_fraction=.05, event_window_ms=20, event_rms_ratio=4, event_sigma=6):
    if not pieces or min(map(len, pieces)) < 64:
        raise ValueError("有效连续片段不足 64 个样本")
    # Same nperseg and grid for all pieces. No window crosses an acquisition gap.
    nperseg = min(65536, min(map(len, pieces)), max(64, int(rate * window_seconds)))
    psd, weights, freq = [], [], None
    for values in pieces:
        freq, power = welch(values, fs=rate, window="hann", nperseg=nperseg, noverlap=nperseg//2, detrend=False, scaling="density")
        weight = 1 + (len(values) - nperseg) // (nperseg - nperseg//2)
        psd.append(power * weight); weights.append(weight)
    power = np.sum(psd, axis=0) / sum(weights)
    df = rate/nperseg
    candidates, _ = find_peaks(power, prominence=max(float(np.max(power))*.03, np.finfo(float).tiny), distance=2)
    candidates = sorted(candidates, key=lambda i: power[i], reverse=True)[:3]
    peaks = []
    for index in candidates:
        if freq[index] <= 0:
            continue
        left, right, half = index, index, power[index]/2
        while left > 0 and power[left] > half: left -= 1
        while right < len(power)-1 and power[right] > half: right += 1
        bandwidth = None
        # Unresolved narrow lines and edge peaks cannot provide reliable damping.
        if left > 0 and right < len(power)-1 and index-left >= 2 and right-index >= 2:
            fl = float(np.interp(half, power[left:left+2], freq[left:left+2]))
            fr = float(np.interp(half, power[right-1:right+1][::-1], freq[right-1:right+1][::-1]))
            bandwidth = fr-fl
        damping = bandwidth/(2*freq[index]) if bandwidth is not None else None
        if damping is not None and not 0 < damping < .2: damping = None
        peaks.append({"frequencyHz":float(freq[index]), "bandRmsVelocityMps":float(np.sqrt(np.sum(power[max(0,index-1):index+2])*df)),
                      "dampingRatioEstimate":damping, "dampingStatus":"peak_bandwidth_estimate" if damping is not None else "unresolved",
                      "kind":"spectral_peak_candidate"})
    # A bounded plot representation preserves source amplitude extrema.
    raw_display, smooth_display, joins, offset = [], [], [], 0
    previous = None
    for values in pieces:
        display = values.copy()
        if previous is not None:
            width=min(max(1,int(min(len(previous),len(values))*fade_fraction)),1024,len(values)//2) if fade_fraction else 0
            before=float(abs(values[0]-previous[-1]))
            ratio=before/max(float(np.sqrt(np.mean(values**2))),1e-15)
            # Raised-cosine correction, without AR-extrapolated pseudo measurements.
            ramp=(1+np.cos(np.linspace(0,np.pi,width)))/2 if width>1 else np.ones(1)
            if width: display[:width]+=(previous[-1]-display[0])*ramp
            joins.append({"compressedSeconds":offset/rate,"jumpBeforeMps":before,"jumpAfterMps":float(abs(display[0]-previous[-1])),"jumpRmsRatio":ratio,"flagged":ratio>.2,"adjustedSamples":width})
        a,b=_time_curve(values,offset,rate),_time_curve(display,offset,rate)
        raw_display.extend(zip(a["seconds"],a["values"]));smooth_display.extend(zip(b["seconds"],b["values"]))
        previous=values;offset+=len(values)
    return {"events":transient_events(pieces,rate,window_ms=event_window_ms,rms_ratio=event_rms_ratio,sigma=event_sigma),"metrics":_metrics(_merge_statistics([_statistics(p) for p in pieces])),"peaks":peaks,
            # Keep every Welch bin for quantitative common-band integration. The
            # Web list omits these arrays; display thinning must not lose power.
            "spectrum":{"frequencies":freq.tolist(),"psd":power.tolist(),"completeBins":True,"unit":"(m/s)^2/Hz","resolutionHz":df,"window":"hann","nperseg":nperseg,"averages":sum(weights),"method":"Welch within each continuous segment; weighted power average"},
            "stitch":{"coordinate":"compressed-valid-time","raw":raw_display,"smoothed":smooth_display,"joins":joins,"displayOnly":True,"fadeFraction":fade_fraction,"method":"raised-cosine boundary correction for display only; not used by spectra or metrics"}}


def analyze_measurement(store, parameters, *, return_pieces=False):
    if not isinstance(parameters,dict) or set(parameters)-{"recordingId","windowSeconds","fadeFraction","detrend","rssiThresholdPercent","eventWindowMs","eventRmsRatio","eventSigma","includeDiagnostic"}:
        raise ValueError("测量分析参数无效")
    recording_id=parameters.get("recordingId")
    if not isinstance(recording_id,str) or not re.fullmatch(r"[a-f0-9]{32}",recording_id): raise ValueError("记录编号无效")
    directory=store.directory(recording_id); manifest=store._read_manifest(directory)
    if manifest.get("status")!="complete" or manifest.get("error"): raise ValueError("记录尚未完整保存或采集异常")
    if manifest.get("source") in ("demo","simulation","mock") or manifest.get("simulation"): raise ValueError("当前分析流程只接受实测记录")
    if manifest.get("source") not in ("measured","device","polytec_ivs500","real"): raise ValueError("请先确认数据为实测来源")
    pc=manifest.get("pointCycle") or manifest.get("sourceMetadata",{}).get("pointCycle")
    include_diagnostic=parameters.get("includeDiagnostic",False)
    if type(include_diagnostic) is not bool: raise ValueError("纳入诊断数据分析必须是布尔值")
    diagnostic=bool(_diagnostic(manifest,pc or {}) or (pc and (pc.get("diagnosticOnly") is True or pc.get("validMeasurement") is False)))
    if diagnostic and not include_diagnostic:
        raise ValueError("该记录为诊断数据；请显式选择纳入诊断分析，仅用于波形复核，不作为健康参考或真实模态结论")
    window=_numeric(parameters.get("windowSeconds",.25),"频谱窗时长",.001,30)
    fade=_numeric(parameters.get("fadeFraction",.05),"展示平滑比例",0,.2)
    detrend=parameters.get("detrend","constant")
    if detrend not in ("none","constant","linear"): raise ValueError("去趋势方式无效")
    threshold=parameters.get("rssiThresholdPercent")
    if threshold is not None:_numeric(threshold,"回波阈值",0,100)
    values,quality,provenance,rssi_values=_raw(store,recording_id,manifest,threshold)
    del rssi_values
    count=len(values);rate=manifest["sampleRate"]
    boundary_basis=None
    if pc:
        candidate,reason,boundary_basis=_range(pc,count,manifest=manifest,include_diagnostic=include_diagnostic,pass_window="detected")
        if candidate is None: raise ValueError("叶片有效经过边界不完整："+str(reason))
    else: candidate=(0,count)
    valid=quality==0 if pc or threshold is not None else (quality & 3)==0
    valid[:candidate[0]]=False;valid[candidate[1]:]=False
    boundaries=np.flatnonzero(np.diff(np.r_[False,valid,False].astype(np.int8))).reshape(-1,2)
    ranges=[(int(a),int(b)) for a,b in boundaries if b-a>=64]
    if not ranges: raise ValueError("没有足够的连续有效样本")
    if len(ranges)>128: raise ValueError("有效片段过碎，请缩小分析范围或核对信号质量")
    pieces=[_preprocess(values[a:b],detrend) for a,b in ranges]
    event_options={"eventWindowMs":_numeric(parameters.get("eventWindowMs",20),"异常检测窗长",5,200),
                   "eventRmsRatio":_numeric(parameters.get("eventRmsRatio",4),"局部RMS倍数",2,20),
                   "eventSigma":_numeric(parameters.get("eventSigma",6),"稳健标准差倍数",3,20)}
    result=signal_features(pieces,rate,window_seconds=window,fade_fraction=fade,event_window_ms=event_options["eventWindowMs"],event_rms_ratio=event_options["eventRmsRatio"],event_sigma=event_options["eventSigma"])
    result.update(status="analyzed",algorithmVersion=VERSION,recordingId=recording_id,parameters={"windowSeconds":window,"fadeFraction":fade,"detrend":detrend,"rssiThresholdPercent":threshold,"includeDiagnostic":include_diagnostic},
                  sampleRate=rate,rawSamples=count,validSamples=sum(map(len,pieces)),validSeconds=sum(map(len,pieces))/rate,provenance=provenance,
                  diagnosticOnly=diagnostic,validMeasurement=not diagnostic,boundaryBasis=boundary_basis,
                  ranges=[{"start":a,"end":b,"startSeconds":a/rate,"endSeconds":b/rate} for a,b in ranges],
                  waveform=[_time_curve(p,a,rate) for p,(a,b) in zip(pieces,ranges)],
                  phaseAvailable=False,conclusion=("诊断记录仅用于波形与频带响应复核，不作为正式健康参考或损伤结论。" if diagnostic else "")+"频谱候选与分布反映响应特征；逐点异步测量不提供真实空间相位，不能直接等同固有模态或损伤确诊")
    result["parameters"].update(event_options)
    attach_event_sources(result,result["ranges"],rate)
    return (result, pieces) if return_pieces else result


def analyze_measurements(store, parameters):
    if not isinstance(parameters,dict) or "recordingIds" not in parameters:
        return analyze_measurement(store,parameters)
    ids=parameters.get("recordingIds")
    if not isinstance(ids,list) or not 1<=len(ids)<=16 or len(set(ids))!=len(ids):
        raise ValueError("合并分析需要 1～16 条不重复记录")
    opts={k:v for k,v in parameters.items() if k!="recordingIds"}
    if "recordingId" in opts: raise ValueError("请选择单条或多条记录之一")
    count=0; source_files=set()
    for record_id in ids:
        if not isinstance(record_id,str) or not re.fullmatch(r"[a-f0-9]{32}",record_id): raise ValueError("记录编号无效")
        manifest=store._read_manifest(store.directory(record_id))
        key=(manifest.get("sourceSha256"),manifest.get("point"))
        if key[0] and key in source_files: raise ValueError("存在同一源文件同一测点的导入副本，请去重")
        if key[0]: source_files.add(key)
        count+=manifest.get("samples",0)
    if count>8_000_000: raise ValueError("合并分析原始样本总量不能超过 800 万")
    sources,pieces,ranges,waves=[],[],[],[]
    rates=set(); seen=set()
    for record_id in ids:
        result,parts=analyze_measurement(store,{**opts,"recordingId":record_id},return_pieces=True)
        identity=(result["provenance"]["originalSampleOrigin"],result["provenance"]["velocitySha256"])
        if identity in seen: raise ValueError("存在相同原始时间与内容的记录副本，请去重")
        seen.add(identity);rates.add(result["sampleRate"])
        if len(rates)>1: raise ValueError("合并分析须使用相同采样率的记录")
        sources.append({"recordingId":record_id,"provenance":result["provenance"],"rawSamples":result["rawSamples"],"validSeconds":result["validSeconds"],"diagnosticOnly":result["diagnosticOnly"],"validMeasurement":result["validMeasurement"],"boundaryBasis":result["boundaryBasis"]})
        pieces.extend(parts)
        ranges.extend({**r,"recordingId":record_id} for r in result["ranges"])
        waves.extend({**w,"recordingId":record_id} for w in result["waveform"])
    if len(pieces)>128: raise ValueError("合并后有效片段超过 128 段，请拆分")
    rate=next(iter(rates))
    result=signal_features(pieces,rate,window_seconds=opts.get("windowSeconds",.25),fade_fraction=opts.get("fadeFraction",.05),event_window_ms=opts.get("eventWindowMs",20),event_rms_ratio=opts.get("eventRmsRatio",4),event_sigma=opts.get("eventSigma",6))
    diagnostic=any(source["diagnosticOnly"] for source in sources)
    result.update(status="analyzed",algorithmVersion=VERSION,recordingIds=ids,parameters={"windowSeconds":opts.get("windowSeconds",.25),"fadeFraction":opts.get("fadeFraction",.05),"detrend":opts.get("detrend","constant"),"rssiThresholdPercent":opts.get("rssiThresholdPercent"),"includeDiagnostic":opts.get("includeDiagnostic",False)},
                  sampleRate=rate,rawSamples=count,validSamples=sum(map(len,pieces)),validSeconds=sum(map(len,pieces))/rate,provenance={"sources":sources,"timeReference":"each source keeps its original time; display concatenation is not a common phase reference"},ranges=ranges,waveform=waves,phaseAvailable=False,
                  diagnosticOnly=diagnostic,validMeasurement=not diagnostic,
                  conclusion=("含诊断记录，仅用于波形与频带响应复核，不作为正式健康参考或损伤结论。" if diagnostic else "")+"同测点同圆周角多次有效经过的功率平均；窗不跨越原始片段或记录边界，不能以累计有效时长提高固有频率分辨率")
    result["parameters"].update({k:opts.get(k,v) for k,v in [("eventWindowMs",20),("eventRmsRatio",4),("eventSigma",6)]})
    attach_event_sources(result,ranges,rate)
    return result
