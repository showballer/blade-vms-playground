"""Versioned post-acquisition jobs. Raw recordings and hardware are never modified."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import csv
import hashlib
import json
import math
from pathlib import Path
import threading
import time
import uuid
import zipfile
import numpy as np
from ..storage import atomic_json
from . import ALGORITHM_VERSION
from .adapter import ID, catalog, load_raw, record_files, source_fingerprint, source_quality
from .quality import assess_record
from .plan import contract,LIMITS,VERSION as PLAN_VERSION,digest as plan_digest
from .presentation import raw_plot, segment_summary, segment_plot, aggregate_plot, plot_indices, spectrum_plot
from .reference import analyze_recording, aggregate_points, build_point_preview, JoinConfig
from .reference.cli import config_from_dict, json_safe, write_preview_csv
from .reference.models import RealSegment, SegmentResult
from .reference.geometry import SignalError
from .reference.dsp import time_frequency, envelope_analysis, bandlimited_kinematics, spectra


def dump(path, value): atomic_json(path, json_safe(value,include_arrays=True))

def strict_keys(body, allowed):
    extra=set(body)-set(allowed)-{"action"}
    if extra: raise SignalError("INVALID_REQUEST", "unknown fields: "+", ".join(sorted(extra)))


def candidate_mapping(m):
    pc=m.get("pointCycle") or {}; clock=pc.get("continuousSession") or {}; e=pc.get("handoff") or {}
    base=clock.get("sampleStart"); a=e.get("entryConfirmedSampleIndex"); b=e.get("exitSampleIndex")
    valid=all(isinstance(x,int) and not isinstance(x,bool) for x in (base,a,b))
    return {"sample_clock":clock.get("sampleClock"),"event_sample_clock":e.get("sampleClock"),
        "global_entry_confirmed":a,"global_exit":b,"record_global_start":base,
        "local_start":a-base if valid else None,"local_end_exclusive":b-base if valid else None,
        "convention":"confirmed_entry_inclusive_to_exit_exclusive_v1"}


def geometry_comparison(bundle, manifest):
    inputs=bundle.get("measurement_inputs") or {};geometry=bundle.get("geometry") or {}
    installation={k:inputs.get(k) for k in ("horizontal_distance_m","hub_height_delta_m","hub_height_m","laser_height_m",
        "blade_length_m","root_radius_m","lateral_offset_m","laser_position_world_m","hub_position_world_m","shaft_axis_world")}
    source=((manifest.get("turntable") or {}).get("config") or {}).get("geometry") or {}
    calibration={k:source.get(k) for k in ("rotationDirection","axis1Sign","axis2Sign","pitchAngleScale","yawAngleScale")}
    calibration["referenceSignature"]=(manifest.get("pointCycle") or {}).get("referenceSignature")
    value={"installation":installation,"calibration":calibration,"model":geometry.get("model"),"assumptions":geometry.get("assumptions")}
    return {"geometryComparisonKey":hashlib.sha256(json.dumps(value,sort_keys=True,allow_nan=False).encode()).hexdigest(),
        "geometryComparisonKnown":bool(geometry),"geometryComparisonSnapshot":value}


def validate_config(profile, supplied):
    if profile not in ("LOS_DIAGNOSTIC","RAW_REVIEW","AXIAL_EQUIVALENT"):
        raise SignalError("INVALID_PROFILE", "unknown published profile")
    if not isinstance(supplied,dict): raise SignalError("INVALID_CONFIG","configuration must be an object")
    defaults={"version":ALGORITHM_VERSION,"background":"none" if profile=="RAW_REVIEW" else "linear"}
    config=config_from_dict({**defaults,**supplied})
    if config.version!=ALGORITHM_VERSION: raise SignalError("INVALID_CONFIG","algorithm version is server controlled")
    if config.projection not in ("los","axial_equivalent") or config.background not in ("none","constant","linear"):
        raise SignalError("INVALID_CONFIG","unknown direction or background")
    if profile!="AXIAL_EQUIVALENT" and config.projection!="los": raise SignalError("INVALID_CONFIG","select the axial profile explicitly")
    if profile=="AXIAL_EQUIVALENT" and config.projection!="axial_equivalent": raise SignalError("INVALID_CONFIG","axial profile requires explicit projection and limits")
    # No turntable setting or nominal period is silently promoted to a measured tach reference.
    if config.rotation_mode!="none": raise SignalError("RPM_REFERENCE_MISSING","record-bound verified rotation reference is not available in this endpoint")
    for field in ("allow_upright_geometry_assumption","rssi_rule_verified","rssi_alignment_verified"):
        if not isinstance(getattr(config,field),bool): raise SignalError("INVALID_CONFIG",field+" must be boolean")
    if not isinstance(config.filter.interference_verified,bool):
        raise SignalError("INVALID_CONFIG","filter.interference_verified must be boolean")
    if config.instrument_sign is not None and (isinstance(config.instrument_sign,bool) or config.instrument_sign not in (-1,1)):
        raise SignalError("INVALID_CONFIG","instrument sign must be -1, +1 or unknown")
    for field in ("quality_guard_seconds","spike_mad_k","min_abs_projection","max_projection_gain",
                  "zero_offset_m_s","spike_sigma_floor_m_s","core_window_seconds","welch_window_seconds","rssi_min_percent"):
        value=getattr(config,field)
        if value is not None and (isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value)):
            raise SignalError("INVALID_CONFIG",field+" must be finite numeric")
    json.dumps(asdict(config),allow_nan=False)
    return config


class RecordAnalysisManager:
    def __init__(self, data_dir: Path, *, recordings_dir: Path|None=None):
        self.recordings=(recordings_dir or data_dir/"recordings").resolve()
        self.root=(data_dir/"record-analysis-v1").resolve(); self.root.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock();self.computation_lock=threading.Lock();self.export_lock=threading.Lock()
        self.executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix="record-analysis")
        self.cancel_events={};self.jobs={}
        for path in self.root.glob("*/job.json"):
            if path.parent.is_symlink() or not ID.fullmatch(path.parent.name):continue
            try:
                state=json.loads(path.read_text(encoding="utf-8"))
                if state.get("jobId")!=path.parent.name:continue
                if state.get("status") in ("running","queued"):
                    state.update(status="cancelled",error="SERVICE_RESTARTED",finishedAt=time.time());dump(path,state)
                self.jobs[path.parent.name]=state
            except (OSError,ValueError):continue

    def close(self):
        with self.lock:
            for event in self.cancel_events.values():event.set()
        self.executor.shutdown(wait=False,cancel_futures=True)

    def catalog(self):
        value=catalog(self.recordings);value["algorithmVersion"]=ALGORITHM_VERSION;value["processingContract"]=contract()
        with self.lock:value["jobs"]=[self._public(j) for j in self.jobs.values()][-100:]
        return value

    def load_recording(self, recording_id):
        return load_raw(self.recordings, recording_id)

    def compare_geometry(self, bundle, manifest):
        return geometry_comparison(bundle, manifest)

    def _directory(self,job_id):
        if not isinstance(job_id,str) or not ID.fullmatch(job_id):raise SignalError("INVALID_JOB_ID","invalid analysis job ID")
        directory=self.root/job_id
        if directory.is_symlink() or directory.resolve().parent!=self.root:raise SignalError("INVALID_JOB_ID","invalid analysis directory")
        if job_id not in self.jobs:raise KeyError("analysis job not found")
        return directory

    @staticmethod
    def _public(state):
        return {k:state.get(k) for k in ("jobId","taskId","scope","profile","status","completed","total","error",
            "createdAt","finishedAt","cacheHit","algorithmVersion","cacheKey","recordingIds","publishedAt")} | {"workspacePurpose":(state.get("workspace") or {}).get("purpose")}

    def _update(self,job_id,**values):
        with self.lock:
            self.jobs[job_id].update(values);dump(self._directory(job_id)/"job.json",self.jobs[job_id])

    def start(self,body):
        strict_keys(body,{"taskId","recordingIds","scope","profile","config","reviewWindows","workspace"})
        tasks=self.catalog()["tasks"]
        task=next((t for t in tasks if t["id"]==body.get("taskId")),None)
        if task is None:raise KeyError("saved task not found")
        ids=body.get("recordingIds",task["recordingIds"])
        if not isinstance(ids,list) or not ids or len(ids)>LIMITS["recordsPerJob"] or any(not isinstance(x,str) for x in ids) or len(ids)!=len(set(ids)):
            raise SignalError("INVALID_RECORDING_SELECTION","select 1..200 distinct saved records")
        if any(r not in task["recordingIds"] for r in ids):raise SignalError("TASK_SCOPE_MISMATCH","records must belong to the selected business task")
        scope=body.get("scope","analysis");profile=body.get("profile","LOS_DIAGNOSTIC")
        # Legacy callers used 'formal' for ordinary plots. It is now analysis,
        # never a certification of source quality or blade health.
        if scope=="formal":scope="analysis"
        if scope not in ("analysis","diagnostic"):raise SignalError("INVALID_SCOPE","unknown quality scope")
        config=validate_config(profile,body.get("config",{}))
        workspace=body.get("workspace")
        if workspace is not None:
            from .workspace import options as workspace_options,VERSION as workspace_version
            if not isinstance(workspace,dict) or set(workspace)!={"purpose","algorithmOptions"} or workspace['purpose'] not in ('signal','synthesis'):raise SignalError('INVALID_CONFIG','Desktop workspace must have a supported purpose and algorithm options')
            workspace={"purpose":workspace['purpose'],"algorithmOptions":workspace_options(workspace['algorithmOptions']),"version":workspace_version}
        review=body.get("reviewWindows",{})
        if not isinstance(review,dict) or set(review)-set(ids):raise SignalError("INVALID_ANALYSIS_WINDOW","review windows must refer to selected records")
        if review and scope!="diagnostic":raise SignalError("REVIEW_IS_DIAGNOSTIC","review windows cannot promote source quality")
        for w in review.values():
            if not isinstance(w,dict) or set(w)!={"start","end","reason"} or not isinstance(w["reason"],str) or not w["reason"].strip():
                raise SignalError("INVALID_ANALYSIS_WINDOW","review window needs start/end and explicit reason")
            if any(isinstance(w[k],bool) or not isinstance(w[k],int) for k in ("start","end")) or not 0<=w["start"]<w["end"]:
                raise SignalError("INVALID_ANALYSIS_WINDOW","invalid review sample range")
        with self.lock:
            if sum(j["status"] in ("queued","running") for j in self.jobs.values())>=2:raise BlockingIOError("已有记录分析任务在运行，请等待完成。")
        fingerprints=[source_fingerprint(self.recordings,r) for r in ids]
        from .reviews import current as current_review
        quality_reviews={r:v for r in task['recordingIds'] if (v:=current_review(self,r)) is not None} if workspace else {}
        policy_sources=[source_fingerprint(self.recordings,r) for r in task['recordingIds']] if workspace else fingerprints
        if sum(f['bytes'] for x in policy_sources for f in x['files'] if f['name'].startswith('chunk-'))>LIMITS['samplesPerJob']*29:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','Selected sources exceed the shared memory budget; split the batch')
        request={"taskId":task["id"],"recordingIds":ids,"scope":scope,"profile":profile,"config":asdict(config),"reviewWindows":review,
                 "algorithmVersion":ALGORITHM_VERSION,"processingContract":contract(),"sources":fingerprints,"policySources":policy_sources,"qualityReviews":quality_reviews,**({"workspace":workspace} if workspace else {})}
        key=hashlib.sha256(json.dumps(request,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
        with self.lock:
            cached=next((j for j in self.jobs.values() if j.get("cacheKey")==key and j["status"]=="complete"),None)
            if cached is not None:
                return {**self._public(cached),"cacheHit":True}
            if sum(j["status"] in ("queued","running") for j in self.jobs.values())>=2:
                raise BlockingIOError("已有记录分析任务在运行，请等待完成。")
            job_id=uuid.uuid4().hex;directory=self.root/job_id;directory.mkdir()
            state={**request,"jobId":job_id,"cacheKey":key,"cacheHit":False,"status":"queued","completed":0,"total":len(ids),"createdAt":time.time(),"error":None}
            self.jobs[job_id]=state;event=threading.Event();self.cancel_events[job_id]=event
            dump(directory/"job.json",state);dump(directory/"task.json",task)
            self.executor.submit(self._run,job_id,config,event)
            return self._public(state)

    def inspect(self,body):
        strict_keys(body,{'recordingId'})
        raw=self.load_recording(body.get('recordingId'))
        return {'recordingId':raw.recording_id,'raw':raw_plot(raw),'manifest':raw.manifest,'candidateWindow':candidate_mapping(raw.manifest),'sourceHash':raw.source_hash}

    def status(self,job_id):
        with self.lock:self._directory(job_id);return self._public(self.jobs[job_id])

    def _save_segment(self,directory,result):
        arrays={"time_s":result.segment.time_s,"rssi_percent":result.segment.rssi_percent,"raw_values_m_s":result.segment.values_m_s}
        arrays.update({"layer__"+k:v for k,v in result.layers.items()})
        arrays.update({"spectrum__"+k:v for k,v in result.spectrum.items() if isinstance(v,np.ndarray)})
        np.savez_compressed(directory/(result.result_id+".npz"),**arrays)
        summary=segment_summary(result)
        summary.update(analysis_start=result.analysis_start,analysis_end=result.analysis_end)
        summary["events"]=result.events
        dump(directory/(result.result_id+".json"),summary)

    def _load_segment(self,job_id,result_id):
        if not isinstance(result_id,str) or len(result_id)!=64 or any(c not in "0123456789abcdef" for c in result_id):
            raise SignalError("SYNTHETIC_INPUT_FORBIDDEN","only saved real-segment result IDs are accepted")
        directory=self._directory(job_id)
        path=directory/(result_id+".json");array_path=directory/(result_id+".npz")
        if path.is_symlink() or array_path.is_symlink():raise SignalError("CACHE_INVALID","analysis cache must contain local regular files")
        meta=json.loads(path.read_text(encoding="utf-8"))
        with np.load(array_path,allow_pickle=False) as z:
            arrays={k:z[k].copy() for k in z.files}
        real=RealSegment(meta["recording_id"],meta["pass_id"],meta["segment_id"],meta["source_hash"],meta["source_start"],
            meta["sample_rate_hz"],arrays["time_s"],arrays["raw_values_m_s"],arrays["rssi_percent"])
        spectrum={**meta["spectrum"],**{k[10:]:v for k,v in arrays.items() if k.startswith("spectrum__")}}
        return SegmentResult(real,meta["layer"],meta["basis"],{k[7:]:v for k,v in arrays.items() if k.startswith("layer__")},
            meta["analysis_start"],meta["analysis_end"],meta["features"],spectrum,meta["events"],meta["status"],meta["parameters"],result_id)

    def _run(self,job_id,config,event):
        with self.computation_lock:self._calculate_job(job_id,config,event)

    def _calculate_job(self,job_id,config,event):
        directory=self._directory(job_id);state=self.jobs[job_id];task=json.loads((directory/"task.json").read_text(encoding="utf-8"))
        bundles=[];summaries=[];raw_metadata=[]
        try:
            self._update(job_id,status="running")
            workspace=state.get('workspace');auto_plan=None
            if workspace:
                from .workspace import policy
                auto_plan=policy(self.load_recording,task['recordingIds'],workspace['algorithmOptions'],config,state.get('qualityReviews'))
            for i,recording_id in enumerate(state["recordingIds"]):
                if event.is_set():raise InterruptedError("ANALYSIS_CANCELLED")
                try:
                    raw=self.load_recording(recording_id)
                    dump(directory/(recording_id+"-raw.json"),raw_plot(raw))
                    quality=source_quality(raw.manifest)
                    if raw.parse_issues:quality["source_flags_allow_formal_review"]=False
                    metadata={"recording_id":recording_id,"source_hash":raw.source_hash,"name":raw.manifest.get("name"),
                        "application_binding":raw.manifest.get("applicationBinding"),"source_quality":quality,"candidate_window":candidate_mapping(raw.manifest),"samples":len(raw.time_s),
                        "sample_rate_hz":raw.sample_rate_hz,"original_seconds":len(raw.time_s)/raw.sample_rate_hz,
                        "started_at":raw.manifest.get("startedAt"),"sample_origin":raw.manifest.get("sampleOrigin"),
                        "object":{"wind_farm":raw.manifest.get("windFarm"),"turbine":raw.manifest.get("turbine"),
                                  "blade":(raw.manifest.get("pointCycle") or {}).get("bladeId"),
                                  "point":(raw.manifest.get("pointCycle") or {}).get("radialPointName"),
                                  "radius_from_hub_m":(raw.manifest.get("pointCycle") or {}).get("radiusM"),
                                  "azimuth_deg":(raw.manifest.get("pointCycle") or {}).get("azimuthDeg")},
                        "nominal_rotor_period_seconds":(raw.manifest.get("pointCycle") or {}).get("nominalPeriodSeconds"),
                        "rotor_reference_source":"manual_estimate" if (raw.manifest.get("pointCycle") or {}).get("nominalPeriodSeconds") else "unknown"}
                    raw_metadata.append(metadata)
                    window=state["reviewWindows"].get(recording_id)
                    if workspace:
                        from .workspace import analyze as workspace_analyze
                        bundle=workspace_analyze(raw,config,workspace['algorithmOptions'],auto_plan,(window['start'],window['end']) if window else None,(state.get('qualityReviews') or {}).get(recording_id))
                    else:bundle=analyze_recording(raw,config=config,explicit_window=(window["start"],window["end"]) if window else None)
                    bundle["source_quality"]=quality
                    assessment=assess_record(raw.manifest,bundle,reviewed=bool(window))
                    bundle["quality_assessment"]=assessment
                    comparison=self.compare_geometry(bundle,raw.manifest)
                    if workspace:
                        from .workspace import comparison as workspace_comparison
                        comparison=workspace_comparison(bundle,raw.manifest,comparison)
                    bundle.update(comparison)
                    for segment in bundle["segments"]:
                        segment.parameters["result_set"]=("record_quality_passed" if state["scope"]=="analysis"
                            and assessment["analysis_eligible"] else "diagnostic")
                        segment.parameters["quality_assessment"]=assessment
                        segment.parameters["analysis_scope"]=state["scope"]
                        segment.parameters["review_window"]=window
                        segment.parameters["confirmed_entry_local_index"]=metadata["candidate_window"]["local_start"]
                        segment.parameters.update(comparison)
                        old_id=segment.result_id
                        segment.result_id=hashlib.sha256(json.dumps({"referenceResultId":old_id,"scope":state["scope"],
                            "sourceQuality":quality,"assessment":assessment,"reviewWindow":window},sort_keys=True,allow_nan=False).encode()).hexdigest()
                        if bundle["representative"]==old_id:bundle["representative"]=segment.result_id
                        self._save_segment(directory,segment)
                    if window:bundle["review_window"]={**window,"source":"explicit_diagnostic_review"}
                    bundles.append(bundle)
                    summary=json_safe(bundle);summary.update(metadata)
                    from .plan import angle
                    summary['object']['original_azimuth_deg']=summary['object']['azimuth_deg'];summary['object']['azimuth_deg']=angle(summary['object']['azimuth_deg'],[],0)['normalized']
                    dump(directory/(recording_id+"-analysis.json"),summary)
                    summary["segments"]=[segment_summary(s) for s in bundle["segments"]]
                    summary["effective_seconds"]=sum(s.features.get("observation_seconds",0) for s in bundle["segments"])
                    summary["quality_events_total"]=len(summary["quality_events"]);summary["quality_events"]=summary["quality_events"][:1000]
                    summaries.append(summary)
                except (OSError,ValueError,TypeError,KeyError) as exc:
                    summaries.append({"recording_id":recording_id,"status":"blocked","issues":[getattr(exc,"code","RAW_READ_FAILED")],"message":str(exc),"segments":[],"representative":None})
                finally:self._update(job_id,completed=i+1)
            if event.is_set():raise InterruptedError("ANALYSIS_CANCELLED")
            aggregates=[];aggregate_issues=[];capture_aliases=[]
            # Isolate missing identities, but reject conflicting duplicate captures in their group.
            groupings={}
            for b in bundles:
                if state["scope"]=="analysis" and not b["quality_assessment"]["analysis_eligible"]:continue
                rep=next((s for s in b["segments"] if s.result_id==b["representative"]),None)
                if rep is None:continue
                o=rep.parameters["object"];key=(*tuple(o.get(k) for k in ("wind_farm","turbine","blade","point")),rep.parameters["geometryComparisonKey"])
                groupings.setdefault(key,[]).append(b)
            for key,group in groupings.items():
                try:
                    seen={};unique=[]
                    for b in group:
                        rep=next(s for s in b['segments'] if s.result_id==b['representative']);capture=rep.parameters['capture_key']
                        if capture in seen:
                            old=seen[capture];a=old.analysis_input();v=rep.analysis_input()
                            if old.layer==rep.layer and old.parameters['config']==rep.parameters['config'] and old.parameters['object']==rep.parameters['object'] and a.source_start==v.source_start and np.array_equal(a.time_s,v.time_s) and np.array_equal(a.values_m_s,v.values_m_s,equal_nan=True):
                                capture_aliases.append({'captureKey':capture,'usedResultId':old.result_id,'duplicateResultId':rep.result_id,'reason':'same_physical_capture_equal_real_arrays'});continue
                            raise SignalError('DUPLICATE_CAPTURE_REQUIRES_SELECTION','Conflicting revisions of a physical capture require explicit selection')
                        seen[capture]=rep;unique.append(b)
                    group[:]=unique
                    values=aggregate_points(group)
                    for value in values:
                        value.update({k:group[0][k] for k in ("geometryComparisonKey","geometryComparisonKnown","geometryComparisonSnapshot")})
                    aggregates.extend(values)
                except SignalError as exc:aggregate_issues.append({"object":list(key),"reasonCode":exc.code,"message":str(exc)})
            comparison_aggregates=[]
            comparison_domains={}
            for key,group in groupings.items():
                representative=next((v for v in group[0]['segments'] if v.result_id==group[0]['representative']),None)
                if representative is not None:comparison_domains.setdefault((*key[:3],representative.layer,representative.basis),[]).append((key,group))
            for domain,items in comparison_domains.items():
                by_point={}
                for key,group in items:
                    by_point.setdefault(key[3],set()).update(s.parameters['object']['azimuth_deg'] for b in group for s in b['segments'] if s.result_id==b['representative'])
                planned={p.get('radialPointName') for p in task.get('plannedPoints',[]) if str(p.get('bladeId'))==str(domain[2])}
                common=set.intersection(*by_point.values()) if by_point and planned<=set(by_point) else set()
                for key,group in items:
                    subset=[b for b in group if any(s.result_id==b['representative'] and s.parameters['object']['azimuth_deg'] in common for s in b['segments'])]
                    try:
                        for value in aggregate_points(subset):value.update(commonAngles=sorted(common),comparisonMeaning='common_observed_angles_only');comparison_aggregates.append(value)
                    except SignalError:pass
            for group in aggregates:self._repeats(group,bundles)
            coverage=self._coverage(task,summaries)
            report={"jobId":job_id,"taskId":task["id"],"taskName":task["name"],"scope":state["scope"],"profile":state["profile"],
                "algorithmVersion":ALGORITHM_VERSION,"config":asdict(config),"records":summaries,**({"workspace":{**workspace,"automaticPlan":auto_plan}} if workspace else {}),
                "aggregates":[aggregate_plot(g) for g in aggregates],"comparisonAggregates":[aggregate_plot(g) for g in comparison_aggregates],"aggregateIssues":aggregate_issues,"captureAliases":capture_aliases,"coverage":coverage,
                "stages":self._stages(),"continuity":"discontinuous_segments","chartAvailability":self._availability(summaries,aggregates),
                "sourceFingerprints":state["sources"],"policySources":state.get("policySources",state["sources"]),"processingContract":contract(),"qualityReviews":state.get("qualityReviews",{}),"phaseAvailable":False,"healthConclusionAvailable":False,
                "qualityPolicy":{"version":"per_record_v1","sourceFlagsPreserved":True,"healthAssessment":"not_performed"},
                "warnings":["不同方位为独立实测片段；不存在同步相位或连续整圈振动。","视线残差仍含未分离运动与测量误差，不等于叶片纯振动。"]}
            # Detect source mutation before publishing a supposedly immutable result version.
            if [source_fingerprint(self.recordings,r) for r in state["recordingIds"]]!=state["sources"]:
                raise SignalError("SOURCE_CHANGED_DURING_ANALYSIS","source recording changed; rerun from the new snapshot")
            if workspace and [source_fingerprint(self.recordings,r) for r in task['recordingIds']]!=state['policySources']:raise SignalError('SOURCE_CHANGED_DURING_ANALYSIS','Policy source set changed')
            dump(directory/"result.json",report)
            self._update(job_id,status="complete",finishedAt=time.time())
        except InterruptedError as exc:self._update(job_id,status="cancelled",error=str(exc),finishedAt=time.time())
        except Exception as exc:self._update(job_id,status="failed",error=f"{getattr(exc,'code',type(exc).__name__)}: {exc}",finishedAt=time.time())
        finally:
            with self.lock:self.cancel_events.pop(job_id,None)

    @staticmethod
    def _stages():
        return [{"id":f"S{i}","name":name} for i,name in enumerate(("原始文件与快照","确认进入到离开映射","硬无效与真实连续段","几何与方向检查",
            "转动参考检查","经验背景与目的滤波","真实分析核心","逐段特征与频谱","经过代表与方位等权","分段展示与独立拟合预览","版本与来源导出"))]

    @staticmethod
    def _coverage(task,records):
        points={}
        for p in task["plannedPoints"]:
            key=(str(p.get("bladeId")),p.get("radialPointName"),p.get("radiusM"))
            point=points.setdefault(key,{"bladeId":p.get("bladeId"),"pointName":p.get("radialPointName"),"radiusM":p.get("radiusM"),"plannedAzimuths":[],"observedAzimuths":[],"usableAzimuths":[]})
            if isinstance(p.get("azimuthDeg"),(int,float)) and p["azimuthDeg"] not in point["plannedAzimuths"]:point["plannedAzimuths"].append(p["azimuthDeg"]%360)
        for r in records:
            o=r.get("object",{});key=(str(o.get("blade")),o.get("point"),o.get("radius_from_hub_m"))
            p=points.setdefault(key,{"bladeId":o.get("blade"),"pointName":o.get("point"),"radiusM":o.get("radius_from_hub_m"),"plannedAzimuths":[],"observedAzimuths":[],"usableAzimuths":[]})
            angle=o.get("azimuth_deg")
            if angle is not None:
                if angle not in p["observedAzimuths"]:p["observedAzimuths"].append(angle)
                if r.get("quality_assessment",{}).get("analysis_eligible") and angle not in p["usableAzimuths"]:p["usableAzimuths"].append(angle)
        for p in points.values():
            for k in ("plannedAzimuths","observedAzimuths","usableAzimuths"):p[k].sort()
            p["missingAzimuths"]=[a for a in p["plannedAzimuths"] if a not in p["usableAzimuths"]]
        usable=sum(bool(r.get("quality_assessment",{}).get("analysis_eligible")) for r in records)
        return {"recordCount":len(records),"analyzableCount":usable,
            "formalEligibleCount":sum(r.get("source_quality",{}).get("source_flags_allow_formal_review",False) for r in records),
            "reviewCount":len(records)-usable,"healthConclusionEligibleCount":0,
            "blockedCount":sum(not r.get("representative") for r in records),"plannedPoints":task["plannedPoints"],"points":list(points.values())}

    @staticmethod
    def _availability(records,groups):
        ready=any(r["status"]=="ready" for r in records)
        result={f"A{i:02d}":{"status":"ready" if ready else "blocked","reasonCodes":[] if ready else ["NO_ELIGIBLE_SEGMENT"],"message":"来自真实连续片段"} for i in range(1,25)}
        for i in (1,2,3):result[f"A{i:02d}"]={"status":"ready" if records else "blocked","reasonCodes":[],"message":"保存的原始数据与事件，不受处理结果阻断"}
        for i in (6,10,11,18):result[f"A{i:02d}"]={"status":"requires_parameters","reasonCodes":["ANALYSIS_PARAMETERS_REQUIRED"],"message":"需明确频带／窗口和边缘政策，不使用隐含默认值"}
        for i,key in ((12,"repeated_waveform"),(13,"repeated_psd")):
            allowed=any(a.get(key,{}).get("status")=="ready" for g in groups for a in g["azimuth_results"])
            result[f"A{i:02d}"]={"status":"ready" if allowed else "blocked","reasonCodes":[] if allowed else ["REPEAT_COUNT_OR_GRID_INSUFFICIENT"],"message":"同方位至少两次合格独立经过，且时间／频率网格兼容"}
        for i in (15,16,17,19):
            result[f"A{i:02d}"]={"status":"ready" if groups else "blocked","reasonCodes":[] if groups else ["NO_COMPARABLE_POINT_RESULT"],"message":"同批次、同物理量与处理口径的点位结果"}
        result["A20"]={"status":"ready" if len(groups)>=2 else "blocked","reasonCodes":[],"message":"只有实测幅值分布；动画相位仅为说明，非实测模态"}
        result["A21"]={"status":"ready" if len({g["blade"] for g in groups})>=2 else "blocked","reasonCodes":["BLADE_COUNT_INSUFFICIENT"] if len({g["blade"] for g in groups})<2 else [],"message":"同口径不同叶片比较"}
        geometry_known=any(g.get("geometryComparisonKnown") for g in groups)
        result["A23"]={"status":"blocked","reasonCodes":["COMPARABLE_HISTORY_NOT_ANALYZED" if geometry_known else "GEOMETRY_UNVERIFIED_FOR_HISTORY"],
            "message":"仅比较已分析的不同批次同口径结果" if geometry_known else "安装几何尚未确认，不把不同批次自动连成趋势"}
        return result

    @staticmethod
    def _repeats(group,bundles):
        results={s.result_id:s for b in bundles for s in b["segments"]}
        for angle in group["azimuth_results"]:
            segments=[results[r] for r in angle["result_ids"]]
            unavailable={"status":"blocked","reasonCodes":["REPEAT_COUNT_INSUFFICIENT"]}
            angle["repeated_waveform"]=unavailable;angle["repeated_psd"]=unavailable
            if len(segments)<2:continue
            real=[r.analysis_input() for r in segments]
            offsets=[(r.source_start-s.parameters["confirmed_entry_local_index"])/r.sample_rate_hz
                     if s.parameters.get("confirmed_entry_local_index") is not None else None for s,r in zip(segments,real)]
            same=offsets[0] is not None and all(o==offsets[0] for o in offsets) and all(len(r.values_m_s)==len(real[0].values_m_s) and r.sample_rate_hz==real[0].sample_rate_hz for r in real)
            if same:
                y=np.mean([r.values_m_s for r in real],axis=0);i=plot_indices(y)
                angle["repeated_waveform"]={"status":"ready","time_s":offsets[0]+np.arange(len(y))[i]/real[0].sample_rate_hz,"velocity_m_s":y[i],
                    "source_indices":i,"alignment":"confirmed_entry_relative_time_not_phase_alignment","result_ids":angle["result_ids"],"display_only":True}
            else:angle["repeated_waveform"]={"status":"blocked","reasonCodes":["REPEAT_TIME_GRID_MISMATCH"]}
            spectra_=[r.spectrum for r in segments]
            if all(s and np.array_equal(s.get("psd_frequency_hz"),spectra_[0].get("psd_frequency_hz")) for s in spectra_):
                psd=np.mean([s["psd_m2_s2_per_hz"] for s in spectra_],axis=0);i=plot_indices(psd)
                angle["repeated_psd"]={"status":"ready","frequency_hz":spectra_[0]["psd_frequency_hz"][i],"psd_m2_s2_per_hz":psd[i],"result_ids":angle["result_ids"]}
            else:angle["repeated_psd"]={"status":"blocked","reasonCodes":["SPECTRAL_PROFILE_MISMATCH"]}

    def result(self,body):
        strict_keys(body,{"jobId","recordingId","segmentId"})
        job_id=body.get("jobId");directory=self._directory(job_id)
        if self.jobs[job_id]["status"]!="complete":raise BlockingIOError("记录分析尚未完成。")
        report=json.loads((directory/"result.json").read_text(encoding="utf-8"))
        report["history"]=self._history(report)
        if report["history"]:report["chartAvailability"]["A23"]={"status":"ready","reasonCodes":[],"message":"不同业务批次、相同处理与量纲的已分析结果"}
        rid=body.get("recordingId")
        if rid is not None:
            record=next((r for r in report["records"] if r["recording_id"]==rid),None)
            if record is None:raise KeyError("record is not part of this analysis")
            raw_path=directory/(rid+"-raw.json")
            detail={"recording_id":rid,"record":record,"raw":json.loads(raw_path.read_text(encoding="utf-8")) if raw_path.exists() else None,"segments":[]}
            selected=[s for s in record["segments"] if body.get("segmentId") in (None,s["segment_id"],s["result_id"])]
            detail["segmentCount"]=len(record["segments"])
            detail["segmentDisplayTruncated"]=len(selected)>32
            for s in selected[:32]:detail["segments"].append(segment_plot(self._load_segment(job_id,s["result_id"])))
            report["detail"]=detail
        return report

    def _history(self,current):
        keys={g["comparison_key"] for g in current["aggregates"] if g.get("geometryComparisonKnown")};seen=set();items=[]
        with self.lock:states=sorted(self.jobs.values(),key=lambda j:j.get("createdAt",0),reverse=True)
        for state in states:
            if state["status"]!="complete" or state["taskId"]==current["taskId"] or state.get("scope")!=current["scope"] or state.get("algorithmVersion")!=ALGORITHM_VERSION:continue
            try:report=json.loads((self._directory(state["jobId"])/"result.json").read_text(encoding="utf-8"))
            except (OSError,ValueError):continue
            for group in report["aggregates"]:
                key=(state["taskId"],group["comparison_key"])
                if not group.get("geometryComparisonKnown") or group["comparison_key"] not in keys or key in seen:continue
                seen.add(key);items.append({"jobId":state["jobId"],"taskId":state["taskId"],"taskName":report.get("taskName"),
                    "createdAt":state.get("createdAt"),"measurementAt":min((r.get("started_at",float("inf")) for r in report["records"] if r.get("started_at") is not None),default=None),"aggregate":group})
        return items

    def preview(self,body):
        strict_keys(body,{"jobId","resultIds","expectedAzimuths","joinConfig","automatic"})
        ids=body.get("resultIds");expected=body.get("expectedAzimuths");config=body.get("joinConfig")
        if not isinstance(ids,list) or not 2<=len(ids)<=16 or len(ids)!=len(set(ids)) or not isinstance(expected,list) or len(expected)!=len(ids):raise SignalError("JOIN_PREVIEW_UNSUPPORTED","select one real representative for each expected azimuth")
        if not isinstance(config,dict) and body.get("automatic") is not True:raise SignalError("JOIN_PREVIEW_UNSUPPORTED","explicit preview parameters required")
        results=[self._load_segment(body.get("jobId"),r) for r in ids]
        report=self.result({"jobId":body["jobId"]})
        allowed={r["representative"] for r in report["records"] if r.get("representative")
                 and (report["scope"]=="diagnostic" or r.get("quality_assessment",{}).get("analysis_eligible"))}
        if not set(ids)<=allowed:raise SignalError("JOIN_PREVIEW_UNSUPPORTED","select eligible pass representatives from this analysis")
        if len({r.parameters.get("geometryComparisonKey") for r in results})!=1:
            raise SignalError("AGGREGATION_BASIS_MISMATCH","preview cannot combine different saved installations")
        if body.get('automatic') is True:
            if not all(r.parameters.get('desktop_workspace') for r in results):raise SignalError('INVALID_CONFIG','Automatic joins require a saved desktop workspace result')
            from .workspace import automatic_preview_config
            config=automatic_preview_config(results)
        try:join_config=JoinConfig(**config)
        except TypeError as exc:raise SignalError("JOIN_PREVIEW_UNSUPPORTED","explicit supported join parameters required") from exc
        values=asdict(join_config)
        if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for v in values.values()):
            raise SignalError("JOIN_PREVIEW_UNSUPPORTED","join parameters must be positive finite numbers")
        if not isinstance(join_config.ar_order,int) or join_config.ar_order>128:
            raise SignalError("ANALYSIS_SIZE_UNSUPPORTED","AR order must be an integer from 1 to 128")
        fs=results[0].segment.sample_rate_hz
        bridge_samples=join_config.duration_seconds*fs
        model_context=join_config.context_seconds*join_config.model_sample_rate_hz
        measured_samples=sum(len(r.analysis_input().values_m_s) for r in results)
        if (bridge_samples>2_000_000 or measured_samples+(len(results)-1)*bridge_samples>8_000_000
                or model_context*join_config.ar_order>2_000_000):
            raise SignalError("ANALYSIS_SIZE_UNSUPPORTED","preview sample count or AR context exceeds the local analysis resource limit")
        joined=build_point_preview(results,expected_azimuths=tuple(expected),config=join_config)
        series=[]
        for b in joined.blocks:
            lo=b["display_start_sample"];n=b["samples"];y=joined.values_m_s[lo:lo+n];i=plot_indices(y)
            series.append({**b,"time_s":(lo+i)/joined.sample_rate_hz,"values_m_s":y[i],"display_source_indices":lo+i,
                "source_indices":(b["source_start"]+i) if b["kind"]=="measured_processed" else None})
        value=json_safe({"kind":joined.kind,"analysis_eligible":False,"series":series,"blocks":joined.blocks,"joins":joined.joins,
            "sample_rate_hz":joined.sample_rate_hz,"measured_samples":joined.measured_samples,"synthetic_samples":joined.synthetic_samples,
            "watermark":"仅展示，含拟合，禁止用于频谱、特征或健康判断","resultIds":ids,"joinConfig":config},include_arrays=True)
        directory=self._directory(body["jobId"]);key=hashlib.sha256(json.dumps({"ids":ids,"expectedAzimuths":expected,"config":config},sort_keys=True).encode()).hexdigest()
        value["previewId"]=key;dump(directory/("preview-"+key+".json"),value)
        write_preview_csv(directory/("preview-"+key+".csv"),joined,results)
        return value

    def extended(self,body):
        strict_keys(body,{"jobId","resultId","resultIds","kind","parameters"})
        kind=body.get("kind");p=body.get("parameters",{})
        if not isinstance(p,dict):raise SignalError("INVALID_CONFIG","parameters must be an object")
        if kind=="workspace_stft":
            result=self._load_segment(body.get('jobId'),body.get('resultId'))
            if not result.parameters.get('desktop_workspace'):raise SignalError('INVALID_CONFIG','Desktop automatic parameters are unavailable')
            from .workspace import auto_stft
            try:return json_safe({'available':True,'kind':'stft','resultId':result.result_id,'parameters':result.parameters['desktop_workspace']['automatic'],'data':auto_stft(result)},include_arrays=True)
            except (ValueError,TypeError) as exc:return {'available':False,'reasonCode':getattr(exc,'code','INSUFFICIENT_OBSERVATION'),'message':str(exc)}
        if kind=="point_band":return self._point_band(body)
        result=self._load_segment(body.get("jobId"),body.get("resultId"));real=result.analysis_input()
        try:
            if kind=="stft":
                # Bound quadratic output before computing: no default or windows crossing seams.
                window=p.get("window_seconds");overlap=p.get("overlap_fraction",.5)
                if not isinstance(window,(int,float)) or not isinstance(overlap,(int,float)) or not 0<=overlap<1:raise SignalError("INVALID_SPECTRAL_CONFIG","explicit STFT window/overlap required")
                size=int(round(window*real.sample_rate_hz));hop=max(1,size-int(size*overlap))
                if size<2 or (size//2+1)*max(1,(len(real.values_m_s)-size)//hop+1)>4_000_000:raise SignalError("ANALYSIS_SIZE_UNSUPPORTED","reduce STFT overlap/window for this segment")
                data=time_frequency(real,**p)
                fidx=np.unique(np.linspace(0,len(data["frequency_hz"])-1,min(256,len(data["frequency_hz"])),dtype=int))
                tidx=np.unique(np.linspace(0,len(data["time_s"])-1,min(256,len(data["time_s"])),dtype=int))
                data.update(frequency_hz=data["frequency_hz"][fidx],time_s=data["time_s"][tidx],psd_m2_s2_per_hz=data["psd_m2_s2_per_hz"][np.ix_(fidx,tidx)],display_only=True)
            elif kind=="envelope":
                data=envelope_analysis(real,**p);i=plot_indices(data["envelope_m_s"],data["filtered_velocity_m_s"])
                for k in ("time_s","envelope_m_s","filtered_velocity_m_s"):data[k]=data[k][i]
                data["spectrum"]=spectrum_plot(data["spectrum"])
            elif kind=="kinematics":
                evidence=p.get("edge_policy_source")
                if result.parameters.get("desktop_workspace") and (not isinstance(evidence,str) or not evidence.strip()):raise SignalError("DERIVATION_POLICY_REQUIRED","Declare and verify a finite-window edge policy")
                args={k:v for k,v in p.items() if k!="edge_policy_source"}
                data=bandlimited_kinematics(real,**args);i=plot_indices(data["displacement_m"],data["acceleration_m_s2"])
                for k in ("time_s","displacement_m","acceleration_m_s2"):data[k]=data[k][i]
            else:raise SignalError("INVALID_ANALYSIS_KIND","unknown extension")
            return json_safe({"available":True,"kind":kind,"resultId":result.result_id,"layer":result.layer,"basis":result.basis,"data":data,"parameters":p},include_arrays=True)
        except (SignalError,TypeError) as exc:return {"available":False,"kind":kind,"resultId":result.result_id,"reasonCode":getattr(exc,"code","ANALYSIS_PARAMETERS_REQUIRED"),"message":str(exc)}

    def _point_band(self,body):
        ids=body.get('resultIds');p=body.get('parameters',{})
        if not isinstance(ids,list) or not ids or len(ids)>LIMITS['recordsPerJob'] or len(ids)!=len(set(ids)) or set(p)!={'band_hz'}:raise SignalError('INVALID_CONFIG','Select distinct real representatives and one declared band')
        report=self.result({'jobId':body['jobId']})
        plan=(report.get('workspace') or {}).get('automaticPlan',{})
        saved=plan.get('automaticBandHz',(report.get('workspace') or {}).get('algorithmOptions',{}).get('targetBandHz'))
        if report.get('workspace') and saved!=p['band_hz']:raise SignalError('TARGET_BAND_NOT_CONFIGURED','Declare target band and its source in a new processing plan')
        allowed={r['representative'] for r in report['records'] if r.get('representative') and (report['scope']=='diagnostic' or r.get('quality_assessment',{}).get('analysis_eligible'))}
        if not set(ids)<=allowed:raise SignalError('REPRESENTATIVE_REQUIRED','Only eligible real representatives are accepted')
        groups={}
        for rid in ids:
            r=self._load_segment(body['jobId'],rid);o=r.parameters['object'];key=(o['wind_farm'],o['turbine'],o['blade'],o['point'],o['radius_from_hub_m'],r.layer,r.basis,r.parameters.get('geometryComparisonKey'))
            group=groups.setdefault(key,{'object':o,'layer':r.layer,'basis':r.basis,'azimuths':{},'excluded':[]})
            try:
                if r.parameters.get('desktop_workspace'):
                    from .workspace import window_spectra
                    spec=window_spectra(r.analysis_input(),r.parameters['desktop_workspace']['algorithmOptions']['window'],r.parameters['config'].get('welch_window_seconds'),tuple(p['band_hz']))
                else:spec=spectra(r.analysis_input(),welch_window_seconds=r.parameters['config'].get('welch_window_seconds'),band_hz=tuple(p['band_hz']))
                if 'grid' in group and not np.array_equal(group['grid'],spec['psd_frequency_hz']):raise SignalError('SPECTRAL_PROFILE_MISMATCH','Physical frequency grids are incompatible')
                group['grid']=spec['psd_frequency_hz']
                group['azimuths'].setdefault(o['azimuth_deg'],[]).append({'resultId':rid,'band_power':spec['band_mean_square_m2_s2'],'bin_centers':spec['evaluated_bin_centers_hz'],'delta_hz':spec['psd_grid_spacing_hz']})
            except (SignalError,ValueError,TypeError) as exc:group['excluded'].append({'resultId':rid,'reasonCode':getattr(exc,'code','INVALID_CONFIG'),'message':str(exc)})
        # Intersection is scoped to one blade and compatible physical direction.
        common={}
        for key,g in groups.items():
            domain=(key[0],key[1],key[2],g['layer'],g['basis']);angles=set(g['azimuths'])
            common[domain]=common[domain]&angles if domain in common else angles
        points=[]
        for key,g in groups.items():
            g.pop('grid',None)
            participating=common[(key[0],key[1],key[2],g['layer'],g['basis'])]
            angles=[{'azimuth_deg':a,'mean_band_power_m2_s2':float(np.mean([v['band_power'] for v in rs])),'mean_band_rms_m_s':float(np.sqrt(np.mean([v['band_power'] for v in rs]))),'records':rs} for a,rs in sorted(g.pop('azimuths').items()) if a in participating]
            power=float(np.mean([v['mean_band_power_m2_s2'] for v in angles])) if angles else None
            points.append({**g,'azimuth_results':angles,'mean_band_power_m2_s2':power,'mean_azimuth_band_rms_m_s':float(np.sqrt(power)) if power is not None else None,'weighting':'equal_capture_then_equal_common_azimuth_power','participatingAzimuths':sorted(participating),'reason':None if angles else 'NO_COMMON_AZIMUTH'})
        return {'available':any(p['azimuth_results'] for p in points),'kind':'point_band','band_hz':p['band_hz'],'points':points,'interpretation':'sqrt(integrated_equal_azimuth_mean_PSD)','targetBandSource':plan.get('targetBandSource'),'bandMode':plan.get('bandMode','custom'),'bandMeaning':plan.get('bandMeaning'),'resolvedBandHz':plan.get('resolvedBandHz'),'frequencyResolutionHz':plan.get('frequencyResolutionHz')}

    def export(self,body):
        strict_keys(body,{"jobId","kind","previewId"})
        job_id=body.get("jobId");report=self.result({"jobId":job_id});directory=self._directory(job_id)
        kind=body.get("kind");out=directory/"exports";out.mkdir(exist_ok=True)
        if kind not in ("analysis","summary","preview","raw"):raise SignalError("INVALID_EXPORT_KIND","unknown analysis export kind")
        if kind=="preview":
            preview_id=body.get("previewId")
            if not isinstance(preview_id,str) or len(preview_id)!=64 or any(c not in "0123456789abcdef" for c in preview_id):raise SignalError("INVALID_PREVIEW_ID","select a saved preview")
            files=[directory/("preview-"+preview_id+extension) for extension in (".csv",".json")]
            if not all(p.is_file() for p in files):raise KeyError("preview not found")
            filename="仅展示_含拟合_"+job_id[:8]+".zip"
        elif kind=="raw":
            if [source_fingerprint(self.recordings,r) for r in self.jobs[job_id]["recordingIds"]]!=self.jobs[job_id]["sources"]:raise SignalError("SOURCE_CHANGED","original files changed since analysis")
            files=[]
            for rid in self.jobs[job_id]["recordingIds"]:
                _,_,paths=record_files(self.recordings,rid);files.extend([self.recordings/rid/"manifest.json",*paths])
            filename="原始记录_"+job_id[:8]+".zip"
        else:
            filename=("真实片段分析_" if kind=="analysis" else "点位统计_")+job_id[:8]+".zip"
            files=[directory/"result.json",directory/"job.json",directory/"task.json"]
            if kind=="analysis":
                for r in report["records"]:
                    complete_record=directory/(r["recording_id"]+"-analysis.json")
                    if complete_record.is_file():files.append(complete_record)
                    for s in r["segments"]:files.extend([directory/(s["result_id"]+".json"),directory/(s["result_id"]+".npz")])
            table=out/"point-summary.csv"
            with table.open("w",encoding="utf-8-sig",newline="") as stream:
                fields=["wind_farm","turbine","blade","point","radius_from_hub_m","layer","basis","result_set","azimuth_count","mean_half_peak_to_peak_m_s","mean_segment_rms_m_s","comparison_key"]
                w=csv.DictWriter(stream,fieldnames=fields,extrasaction="ignore");w.writeheader();w.writerows(report["aggregates"])
            files.append(table)
        path=out/filename;temporary=out/(filename+".part")
        with zipfile.ZipFile(temporary,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
            for f in files:
                if f.is_symlink():raise SignalError("CACHE_INVALID","export source cannot be symlink")
                name=f.relative_to(self.recordings).as_posix() if kind=="raw" else f.name
                archive.write(f,name)
            archive.writestr("README.txt",f"算法 {ALGORITHM_VERSION}\n结果集合 {report['scope']}\n单位 SI。缺失无补零。拟合预览禁止进入频谱或健康判断。可分析结果不等于正式健康结论，原始质量标记保持不变。\n")
        temporary.replace(path)
        return {"path":str(path),"fileName":filename,"mimeType":"application/zip","bytes":path.stat().st_size}

    def handle(self,body):
        if not isinstance(body,dict):raise SignalError("INVALID_REQUEST","request must be an object")
        action=body.get("action")
        if action=='contract':strict_keys(body,set());return contract()
        if action=='review':
            from .reviews import save
            return save(self,body)
        if action=='review_history':
            strict_keys(body,{'recordingId'})
            from .reviews import history
            return {'history':history(self,body.get('recordingId'))}
        if action=="publish":
            strict_keys(body,{"jobId","actor"});saved=self.result({"jobId":body.get("jobId")})
            if not saved.get("workspace") or saved.get("processingContract")!=contract():raise SignalError("LEGACY_RESULT_READONLY","Recalculate this historical plan before publishing")
            if not isinstance(body.get("actor"),str) or not body["actor"].strip():raise SignalError("REVIEW_ACTOR_REQUIRED","Authenticated actor required")
            self._update(body["jobId"],publishedAt=time.time(),publishedBy=body["actor"])
            return {"published":True,"jobId":body["jobId"]}
        if action=="package":
            strict_keys(body,{"jobId"})
            from .packages import create
            return create(self,body.get("jobId"))
        if action=="catalog":strict_keys(body,set());return self.catalog()
        if action=="inspect":return self.inspect(body)
        if action=="start":return self.start(body)
        if action in ("status","cancel"):
            strict_keys(body,{"jobId"});job_id=body.get("jobId");self._directory(job_id)
            if action=="cancel":
                with self.lock:
                    if job_id in self.cancel_events:self.cancel_events[job_id].set()
            return self.status(job_id)
        if action=="result":return self.result(body)
        if action in ("preview","extended"):
            if not self.computation_lock.acquire(blocking=False):raise BlockingIOError("已有记录分析正在计算，请等待完成。")
            try:return self.preview(body) if action=="preview" else self.extended(body)
            finally:self.computation_lock.release()
        if action=="export":
            if not self.export_lock.acquire(blocking=False):raise BlockingIOError("已有分析结果正在导出，请等待完成。")
            try:return self.export(body)
            finally:self.export_lock.release()
        raise SignalError("INVALID_ACTION","unknown record analysis action")
