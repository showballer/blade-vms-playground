"""Local JSON/NPZ bridge. It never connects to a server or modifies source exports."""
from __future__ import annotations

import argparse
import csv
from dataclasses import asdict, fields
import json
import math
from pathlib import Path
import sys
from typing import Any

import numpy as np

from . import __version__
from .aggregate import aggregate_points
from .geometry import SignalError
from .io import iter_zip_recordings
from .models import AnalysisConfig, DisplayPreview, FilterSpec, RotationReference, SegmentResult
from .pipeline import analyze_recording
from .stitch import JoinConfig, build_point_preview


def config_from_dict(value: dict | None) -> AnalysisConfig:
    data = dict(value or {})
    if set(data)-{f.name for f in fields(AnalysisConfig)}:
        raise SignalError("INVALID_CONFIG", "unknown analysis configuration keys")
    f = dict(data.pop("filter",{}))
    if set(f)-{x.name for x in fields(FilterSpec)}:
        raise SignalError("INVALID_CONFIG", "unknown filter configuration keys")
    if "cutoffs_hz" in f:
        f["cutoffs_hz"] = tuple(f["cutoffs_hz"])
    if data.get("band_hz") is not None:
        data["band_hz"] = tuple(data["band_hz"])
    return AnalysisConfig(**data,filter=FilterSpec(**f))


def json_safe(value: Any, *, include_arrays: bool = False) -> Any:
    if isinstance(value,SegmentResult):
        return dict(result_id=value.result_id,recording_id=value.segment.recording_id,
            segment_id=value.segment.segment_id,source_start=value.segment.source_start,
            source_end=value.segment.source_end,analysis_source_start=value.segment.source_start+value.analysis_start,
            analysis_source_end=value.segment.source_start+value.analysis_end,layer=value.layer,basis=value.basis,
            features=json_safe(value.features,include_arrays=include_arrays),
            spectrum=json_safe(value.spectrum,include_arrays=include_arrays),
            events=json_safe(value.events,include_arrays=include_arrays),
            status=json_safe(value.status,include_arrays=include_arrays),
            parameters=json_safe(value.parameters,include_arrays=include_arrays),
            arrays_file=f"{value.result_id}.npz",
            layers=json_safe(value.layers,include_arrays=include_arrays))
    if isinstance(value,np.ndarray):
        if include_arrays:
            return json_safe(value.tolist(),include_arrays=True)
        return dict(shape=list(value.shape),dtype=str(value.dtype),storage="see_segment_npz_or_call_with_include_arrays")
    if isinstance(value,dict):
        return {str(k):json_safe(v,include_arrays=include_arrays) for k,v in value.items()}
    if isinstance(value,(list,tuple)):
        return [json_safe(v,include_arrays=include_arrays) for v in value]
    if isinstance(value,np.generic):
        return json_safe(value.item(),include_arrays=include_arrays)
    if isinstance(value,float) and not math.isfinite(value):
        return None
    return value


def _load(path: str | None) -> dict:
    return {} if path is None else json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _inputs_for(value: dict,recording_id: str) -> dict:
    if "shared" in value or "by_recording_id" in value:
        unknown = set(value)-{"shared","by_recording_id"}
        if unknown:
            raise SignalError("UNKNOWN_MEASUREMENT_FIELD", str(sorted(unknown)))
        return {**value.get("shared",{}),**value.get("by_recording_id",{}).get(recording_id,{})}
    return value


def write_preview_csv(path: Path, preview: DisplayPreview, results: list[SegmentResult]) -> None:
    """Export a typed display table; the entire table is forbidden as analysis input."""
    lookup = {r.result_id:r for r in results}
    columns = ["display_sample","display_time_s","velocity_m_s","sample_type","analysis_eligible",
        "recording_id","segment_id","result_id","source_sample_index","source_time_s","join_id","layer","basis"]
    with path.open("w",encoding="utf-8-sig",newline="") as stream:
        writer = csv.DictWriter(stream,fieldnames=columns)
        writer.writeheader()
        for block in preview.blocks:
            start,count = block["display_start_sample"],block["samples"]
            real = lookup[block["result_id"]].analysis_input() if block["kind"]=="measured_processed" else None
            for j in range(count):
                i = start+j
                row = dict(display_sample=i,display_time_s=i/preview.sample_rate_hz,
                    velocity_m_s=float(preview.values_m_s[i]),sample_type=block["kind"],analysis_eligible="false")
                if real is not None:
                    row.update(recording_id=real.recording_id,segment_id=real.segment_id,result_id=block["result_id"],
                        source_sample_index=real.source_start+j,source_time_s=float(real.time_s[j]),
                        layer=block["layer"],basis=block["basis"])
                else:
                    row["join_id"] = block["join_id"]
                writer.writerow(row)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read measurement snapshots; analyze real segments; optional display-only join")
    parser.add_argument("--zip",action="append",required=True,dest="archives")
    parser.add_argument("--out",required=True)
    parser.add_argument("--measurement-inputs",help="optional current form values; omitted means read recorded snapshot")
    parser.add_argument("--config",help="analysis configuration JSON")
    parser.add_argument("--rotation-references",help="recording-id to actual rotor reference JSON; never turntable speed")
    parser.add_argument("--include-arrays",action="store_true",help="also embed numeric arrays in JSON")
    parser.add_argument("--preview-point")
    parser.add_argument("--preview-azimuths",help="explicit comma-separated required station order")
    parser.add_argument("--join-config",help="all join durations are explicit runtime display configuration")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True,exist_ok=True)
    bundles,failures,raw_counts = [],[],0
    try:
        config = config_from_dict(_load(args.config))
        supplied,references = _load(args.measurement_inputs),_load(args.rotation_references)
        for path in args.archives:
            for record in iter_zip_recordings(path):
                raw_counts += 1
                try:
                    ref = references.get(record.recording_id)
                    reference = RotationReference(record.recording_id,ref["source"],ref["rpm"],ref.get("time_s")) if ref else None
                    bundle = analyze_recording(record,_inputs_for(supplied,record.recording_id),config,rotation_reference=reference)
                    for result in bundle["segments"]:
                        arrays = {f"layer__{k}":v for k,v in result.layers.items()}
                        arrays.update(time_s=result.segment.time_s,rssi_percent=result.segment.rssi_percent)
                        arrays.update({f"spectrum__{k}":v for k,v in result.spectrum.items() if isinstance(v,np.ndarray)})
                        np.savez_compressed(out/f"{result.result_id}.npz",**arrays)
                    bundles.append(bundle)
                except (SignalError,ValueError,TypeError,KeyError) as exc:
                    failures.append(dict(recording_id=record.recording_id,code=getattr(exc,"code","INVALID_INPUT"),message=str(exc)))
        aggregate_error = None
        try:
            aggregates = aggregate_points(bundles)
        except SignalError as exc:
            aggregates,aggregate_error = [],dict(code=exc.code,message=str(exc))
        for i,aggregate in enumerate(aggregates):
            psd = aggregate.get("cross_azimuth_psd")
            if psd is not None:
                filename = f"aggregate_{i:03d}_psd.npz"
                np.savez_compressed(out/filename,**psd)
                aggregate["arrays_file"] = filename
        preview_summary = None
        if args.preview_point:
            try:
                if not args.preview_azimuths or not args.join_config:
                    raise SignalError("JOIN_PREVIEW_UNSUPPORTED", "explicit azimuth order and join config required")
                selected = [s for b in bundles for s in b["segments"]
                    if s.result_id==b["representative"] and s.parameters["object"]["point"]==args.preview_point]
                preview = build_point_preview(selected,expected_azimuths=tuple(float(x) for x in args.preview_azimuths.split(",")),
                    config=JoinConfig(**_load(args.join_config)))
                np.savez_compressed(out/"display_preview_only.npz",values_m_s=preview.values_m_s,
                    display_time_s=np.arange(len(preview.values_m_s))/preview.sample_rate_hz)
                write_preview_csv(out/"display_preview_only.csv",preview,selected)
                preview_summary = dict(status="ready",analysis_eligible=False,axis="compressed_preview",
                    arrays_file="display_preview_only.npz",csv_file="display_preview_only.csv",measured_samples=preview.measured_samples,
                    synthetic_samples=preview.synthetic_samples,blocks=preview.blocks,joins=preview.joins)
            except (SignalError,ValueError,TypeError) as exc:
                preview_summary = dict(status="blocked",code=getattr(exc,"code","INVALID_JOIN_CONFIG"),message=str(exc))
        report = dict(algorithm_version=__version__,raw_record_count=raw_counts,
            analyzable_record_count=sum(b["representative"] is not None for b in bundles),
            records=bundles,aggregates=aggregates,aggregate_error=aggregate_error,failures=failures,
            preview=preview_summary,source_data_modified=False,uploaded=False,
            formal_quality_certified_by_library=False)
        safe = json_safe(report,include_arrays=args.include_arrays)
        (out/"analysis.json").write_text(json.dumps(safe,ensure_ascii=False,indent=2,allow_nan=False),encoding="utf-8")
        print(json.dumps(dict(output=str(out/"analysis.json"),raw_records=raw_counts,
            analyzable_records=report["analyzable_record_count"],failed_records=len(failures),
            blocked_records=sum(b["representative"] is None for b in bundles),
            preview_status=preview_summary["status"] if preview_summary else "not_requested"),ensure_ascii=False))
        return 0 if not failures else 2
    except (SignalError,ValueError,TypeError,KeyError,OSError,EOFError) as exc:
        print(json.dumps(dict(code=getattr(exc,"code","INVALID_INPUT"),message=str(exc)),ensure_ascii=False),file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
