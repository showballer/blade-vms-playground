"""Read native saved samples without opening the rebuildable SQLite index or writing sources."""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
import re
import numpy as np
from ..storage import HEADER, MAGIC, RECORD_DTYPE, recording_rssi_stride
from .reference.models import RawRecording
from .reference.geometry import SignalError, read_measurement_inputs

ID = re.compile(r"^[a-f0-9]{32}$")
CHUNK = re.compile(r"^chunk-[0-9]{8}\.bin$")
MAX_SAMPLES = 30_000_000


def record_files(root: Path, recording_id: str):
    if not isinstance(recording_id, str) or not ID.fullmatch(recording_id):
        raise SignalError("INVALID_RECORDING_ID", "invalid saved recording ID")
    directory = root / recording_id
    if directory.is_symlink() or directory.resolve().parent != root.resolve() or not directory.is_dir():
        raise FileNotFoundError(recording_id)
    path = directory / "manifest.json"
    if path.is_symlink() or path.stat().st_size > 1024*1024:
        raise SignalError("MANIFEST_INVALID", "invalid saved manifest")
    raw_manifest = path.read_bytes()
    manifest = json.loads(raw_manifest)
    if manifest.get("id") != recording_id:
        raise SignalError("RECORDING_ID_CONFLICT", "directory and manifest IDs differ")
    chunks = sorted(p for p in directory.iterdir() if CHUNK.fullmatch(p.name))
    if any(p.is_symlink() or not p.is_file() for p in chunks):
        raise SignalError("CHUNK_INVALID", "raw chunks must be regular local files")
    if any(p.name.endswith(".part") for p in directory.iterdir()):
        raise SignalError("RECORDING_INCOMPLETE", "unfinished raw chunks remain")
    return manifest, raw_manifest, chunks


def source_fingerprint(root: Path, recording_id: str) -> dict:
    manifest, raw_manifest, paths = record_files(root, recording_id)
    files = [{"name":"manifest.json", "sha256":hashlib.sha256(raw_manifest).hexdigest(), "bytes":len(raw_manifest)}]
    for path in paths:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while data := stream.read(1024*1024): digest.update(data)
        files.append({"name":path.name,"sha256":digest.hexdigest(),"bytes":path.stat().st_size})
    fingerprint = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return {"recordingId":recording_id,"sha256":fingerprint,"files":files}


def load_raw(root: Path, recording_id: str) -> RawRecording:
    manifest, manifest_bytes, paths = record_files(root, recording_id)
    if manifest.get("status") != "complete":
        raise SignalError("RECORDING_INCOMPLETE", "only complete saved records can be analyzed")
    rate, count = manifest.get("sampleRate"), manifest.get("samples")
    if isinstance(rate, bool) or not isinstance(rate,(int,float)) or not math.isfinite(rate) or rate<=0:
        raise SignalError("SAMPLE_RATE_INVALID", "positive finite sample rate required")
    if isinstance(count,bool) or not isinstance(count,int) or not 1<=count<=MAX_SAMPLES:
        raise SignalError("RECORDING_SIZE_UNSUPPORTED", f"saved record must contain 1..{MAX_SAMPLES} samples")
    if manifest.get("unit") not in (None,"m/s"):
        raise SignalError("UNIT_CONFLICT", "saved velocity unit must be m/s")
    recording_rssi_stride(manifest)
    t = np.empty(count); v = np.empty(count); r = np.full(count,np.nan); over = np.empty(count)
    digest = hashlib.sha256(manifest_bytes)
    offset = 0
    issues = []
    for path in paths:
        blob = path.read_bytes(); digest.update(path.name.encode()); digest.update(blob)
        if len(blob)<HEADER.size or (len(blob)-HEADER.size)%RECORD_DTYPE.itemsize:
            raise SignalError("CHUNK_TRUNCATED", path.name)
        magic, fs, origin, start = HEADER.unpack(blob[:HEADER.size])
        if magic!=MAGIC or fs!=rate or start!=offset or origin!=manifest.get("sampleOrigin"):
            raise SignalError("CHUNK_HEADER_CONFLICT", path.name)
        data=np.frombuffer(blob, dtype=RECORD_DTYPE, offset=HEADER.size)
        end=offset+len(data)
        if end>count: raise SignalError("SAMPLE_COUNT_CONFLICT", path.name)
        # Retain each stored clock; non-unit steps are split by quality.extract_segments.
        indices=data["index"].astype(np.float64)
        if np.any(np.diff(indices)<=0) or (offset and indices[0]<=t[offset-1]*rate):
            raise SignalError("SAMPLE_CLOCK_REVERSED", path.name)
        t[offset:end]=indices/rate; v[offset:end]=data["velocity"]
        sampled=(data["flags"]&2)!=0
        r[offset:end]=np.where(sampled,data["rssi"],np.nan)
        over[offset:end]=(data["flags"]&1)!=0
        if not np.array_equal(indices,np.arange(offset,end)): issues.append("SOURCE_SAMPLE_CLOCK_GAP")
        offset=end
    if offset!=count: raise SignalError("SAMPLE_COUNT_CONFLICT", "manifest and raw sample count differ")
    return RawRecording(recording_id,float(rate),t,v,r,over,manifest,digest.hexdigest(),
                        f"native:{recording_id}",tuple(sorted(set(issues))))


def source_quality(manifest):
    pc=manifest.get("pointCycle") or {}
    allow=(manifest.get("diagnosticOnly") is False and manifest.get("validMeasurement") is True
           and pc.get("identityVerified") is True and manifest.get("source")!="simulation"
           and not manifest.get("simulation"))
    return {"diagnostic_only":manifest.get("diagnosticOnly"),"valid_measurement":manifest.get("validMeasurement"),
            "identity_verified":pc.get("identityVerified"),"source_flags_allow_formal_review":allow,
            "formal_quality_certified_by_library":False}


def task_key(manifest):
    """Same business namespace as field-recording-tasks.tsx, never display-name grouping."""
    pc=manifest.get("pointCycle") or {}
    kind, value="record",manifest["id"]
    for candidate, identifier in (("collection",pc.get("collectionId")),("session",pc.get("sessionId")),
                                   ("capture",manifest.get("captureSessionId"))):
        if isinstance(identifier,str) and ID.fullmatch(identifier):
            kind,value=candidate,identifier;break
    text=lambda v:v.strip() if isinstance(v,str) else ""
    scope=json.dumps([text(manifest.get(k)) for k in ("windFarm","turbine","object")],ensure_ascii=False,separators=(",",":"))
    return json.dumps([kind,value,scope],ensure_ascii=False,separators=(",",":"))


def catalog(root: Path):
    tasks={}; errors=[]
    if not root.exists(): return {"tasks":[],"revision":hashlib.sha256(b"").hexdigest(),"errors":[]}
    revision=hashlib.sha256()
    for directory in sorted(root.iterdir()):
        if not ID.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir(): continue
        try:
            m, raw, _ = record_files(root,directory.name)
            revision.update(raw)
            pc=m.get("pointCycle") or {}
            identity=task_key(m)
            task_id=hashlib.sha256(identity.encode()).hexdigest()[:32]
            task=tasks.setdefault(task_id,{"id":task_id,"name":m.get("name") or m["id"],"windFarm":m.get("windFarm"),
                "turbine":m.get("turbine"),"object":m.get("object"),"taskKey":identity,"collectionId":pc.get("collectionId"),"recordingIds":[],"records":[],"plannedPoints":[]})
            try: inputs=read_measurement_inputs(m).snapshot()
            except SignalError as exc: inputs={"error":str(exc)}
            task["recordingIds"].append(m["id"])
            task["records"].append({"id":m["id"],"name":m.get("name"),"bladeId":pc.get("bladeId"),
                "pointName":pc.get("radialPointName") or m.get("point"),"radiusM":pc.get("radiusM"),
                "azimuthDeg":pc.get("azimuthDeg"),"createdAt":m.get("startedAt"),"endedAt":m.get("endedAt"),
                "samples":m.get("samples"),"sampleRate":m.get("sampleRate"),"status":m.get("status"),
                "sourceQuality":source_quality(m),"measurementInputs":inputs,
                "importSource":m.get("importSource"),"mergedTask":m.get("mergedTask")})
            for p in pc.get("plannedStations",[]):
                item={k:p.get(k) for k in ("bladeId","radialPointId","radialPointName","radiusM","azimuthDeg","bladeLengthM")}
                if item not in task["plannedPoints"]: task["plannedPoints"].append(item)
        except (OSError,ValueError,KeyError,TypeError) as exc: errors.append({"recordingId":directory.name,"reason":str(exc)})
    for task in tasks.values():
        task["records"].sort(key=lambda r:(str(r["bladeId"]),r["radiusM"] if isinstance(r["radiusM"],(float,int)) else -1,r["azimuthDeg"] or 0,r["createdAt"] or 0))
        task["recordingIds"]=[r["id"] for r in task["records"]]
    return {"tasks":sorted(tasks.values(),key=lambda t:max((r["createdAt"] or 0 for r in t["records"]),default=0),reverse=True),
            "revision":revision.hexdigest(),"errors":errors}
