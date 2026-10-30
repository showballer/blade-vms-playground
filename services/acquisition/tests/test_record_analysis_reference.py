from __future__ import annotations

# Adapted from the read-only 2026-10-28 reference acceptance suite.
# Synthetic fixtures stay isolated; this suite never opens acquisition hardware.

from dataclasses import replace
import hashlib
import math
import unittest

import numpy as np

from blade_acquisition.record_analysis.reference import (AnalysisConfig,FilterSpec,MeasurementInputs,RawRecording,RotationReference,
    SignalError,analyze_recording,fixed_station_geometry,read_measurement_inputs)
from blade_acquisition.record_analysis.reference.aggregate import aggregate_points
from blade_acquisition.record_analysis.reference.dsp import (bandlimited_kinematics,envelope_analysis,features,filter_continuous,
    spectra,spike_candidates,time_frequency)
from blade_acquisition.record_analysis.reference.models import DisplayPreview,RealSegment
from blade_acquisition.record_analysis.reference.quality import candidate_window,extract_segments
from blade_acquisition.record_analysis.reference.stitch import JoinConfig,build_point_preview,join_arrays


def recording(rid="r0",angle=0,amplitude=.002,*,n=4000,fs=4000,values=None):
    t=np.arange(n)/fs
    y=.01+amplitude*np.sin(2*np.pi*200*t) if values is None else np.asarray(values)
    manifest=dict(id=rid,sampleRate=fs,samples=n,windFarm="farm",turbine="turbine",
        diagnosticOnly=True,validMeasurement=False,
        pointCycle=dict(bladeId="2",radialPointName="P2",radiusM=20.,bladeLengthM=40.,rootRadiusM=0.,
            distanceFromRootM=20.,azimuthDeg=angle,identityVerified=False,
            handoff=dict(sampleClock="raw",entryConfirmedSampleIndex=1000,exitSampleIndex=1000+n),
            continuousSession=dict(id=rid,sampleClock="raw",sampleStart=1000,sampleEndExclusive=1000+n)),
        turntable=dict(config=dict(geometry=dict(distanceM=120.,hubHeightDeltaM=60.),speedRpm=99.,nominalPeriodSeconds=1.)))
    return RawRecording(rid,fs,t,y,np.full(n,30.),np.zeros(n),manifest,
        hashlib.sha256(np.asarray(y,dtype="<f8").tobytes()).hexdigest())


def segment(record=None):
    record=record or recording()
    return extract_segments(record,AnalysisConfig())[0][0]


def representative(bundle):
    return next(s for s in bundle["segments"] if s.result_id==bundle["representative"])


class InputTests(unittest.TestCase):
    def test_reads_existing_snapshot(self):
        p=read_measurement_inputs(recording().manifest)
        self.assertEqual((p.horizontal_distance_m,p.hub_height_delta_m,p.blade_length_m,p.radius_from_hub_m),(120.,60.,40.,20.))
        self.assertIn("manifest.",p.source["blade_length_m"])

    def test_uses_each_measurements_heights_not_constants(self):
        p=read_measurement_inputs(recording().manifest,dict(hub_height_m=137.4,laser_height_m=2.1,blade_length_m=71.2))
        self.assertAlmostEqual(p.hub_height_delta_m,135.3)
        self.assertEqual(p.blade_length_m,71.2)
        q=read_measurement_inputs(recording().manifest,dict(hub_height_m=87.,laser_height_m=1.8))
        self.assertAlmostEqual(q.hub_height_delta_m,85.2)
        self.assertNotEqual(p.hub_height_delta_m,q.hub_height_delta_m)

    def test_relative_height_is_sufficient(self):
        p=read_measurement_inputs(recording().manifest)
        self.assertIsNone(p.hub_height_m)
        self.assertIsNone(p.laser_height_m)
        self.assertIsNotNone(fixed_station_geometry(p,allow_upright_assumption=True))

    def test_zero_is_not_missing(self):
        p=read_measurement_inputs(recording().manifest,dict(hub_height_m=10.,laser_height_m=0.,azimuth_deg=0.,root_radius_m=0.))
        self.assertEqual(p.laser_height_m,0.)
        self.assertEqual(p.hub_height_delta_m,10.)

    def test_explicit_null_does_not_fallback(self):
        p=read_measurement_inputs(recording().manifest,dict(horizontal_distance_m=None))
        self.assertIsNone(p.horizontal_distance_m)
        with self.assertRaisesRegex(SignalError,"GEOMETRY_MISSING"):
            fixed_station_geometry(p,allow_upright_assumption=True)

    def test_absolute_relative_height_conflict(self):
        with self.assertRaisesRegex(SignalError,"MEASUREMENT_INPUT_CONFLICT"):
            read_measurement_inputs(recording().manifest,dict(hub_height_m=30.,laser_height_m=3.,hub_height_delta_m=28.))

    def test_radius_never_uses_blade_length(self):
        r=recording();r.manifest["pointCycle"].pop("radiusM");r.manifest["pointCycle"].pop("distanceFromRootM")
        p=read_measurement_inputs(r.manifest)
        self.assertIsNone(p.radius_from_hub_m)
        with self.assertRaisesRegex(SignalError,"GEOMETRY_MISSING"):
            fixed_station_geometry(p,allow_upright_assumption=True)

    def test_current_root_distance_recomputes_radius(self):
        p=read_measurement_inputs(recording().manifest,dict(root_radius_m=2.,distance_from_root_m=10.))
        self.assertEqual(p.radius_from_hub_m,12.)

    def test_invalid_distance_and_unknown_field(self):
        for x in (0.,-1.,float("nan")):
            with self.assertRaises(SignalError):read_measurement_inputs(recording().manifest,dict(horizontal_distance_m=x))
        with self.assertRaisesRegex(SignalError,"UNKNOWN_MEASUREMENT_FIELD"):
            read_measurement_inputs(recording().manifest,dict(unrecognized_height=100))


class GeometryTests(unittest.TestCase):
    def test_simplified_coordinate_formula_randomized(self):
        rng=np.random.default_rng(13)
        for _ in range(80):
            D=float(rng.uniform(30,300));dz=float(rng.uniform(1,140));R=float(rng.uniform(1,50));angle=float(rng.uniform(-180,180));lat=float(rng.uniform(-20,20))
            p=MeasurementInputs(horizontal_distance_m=D,hub_height_delta_m=dz,radius_from_hub_m=R,azimuth_deg=angle,lateral_offset_m=lat)
            g=fixed_station_geometry(p,allow_upright_assumption=True);theta=math.radians(angle)
            L=math.sqrt(D*D+(R*math.sin(theta)-lat)**2+(dz-R*math.cos(theta))**2)
            self.assertAlmostEqual(g.rotational_los_per_rad_s_m,R*(dz*math.sin(theta)-lat*math.cos(theta))/L,places=11)
            self.assertAlmostEqual(g.axial_projection,D/L,places=12)
            self.assertAlmostEqual(g.axial_projection**2+g.radial_projection**2+g.tangential_projection**2,1.,places=12)

    def test_requires_explicit_simplified_convention(self):
        with self.assertRaisesRegex(SignalError,"GEOMETRY_CONVENTION_REQUIRED"):
            fixed_station_geometry(read_measurement_inputs(recording().manifest))

    def test_world_pose_handles_nonhorizontal_axis(self):
        axis=np.array([1.,0.,1.]);axis/=np.linalg.norm(axis)
        p=MeasurementInputs(laser_position_world_m=(-30.,4.,2.),hub_position_world_m=(0.,0.,40.),
            station_position_world_m=(0.,10.,40.),shaft_axis_world=tuple(axis))
        g=fixed_station_geometry(p)
        expected=np.asarray(g.los_unit)@np.cross(axis,np.asarray(g.radius_vector_m))
        self.assertAlmostEqual(g.rotational_los_per_rad_s_m,expected)
        self.assertEqual(g.model,"world_pose_fixed_station")

    def test_missing_lateral_offset_is_marked_assumed(self):
        g=fixed_station_geometry(read_measurement_inputs(recording().manifest),allow_upright_assumption=True)
        self.assertIn("lateral_centering_assumed",g.assumptions)

    def test_outside_blade_and_partial_pose_refused(self):
        p=read_measurement_inputs(recording().manifest,dict(radius_from_hub_m=50.))
        with self.assertRaisesRegex(SignalError,"POINT_OUTSIDE_BLADE"):fixed_station_geometry(p,allow_upright_assumption=True)
        with self.assertRaisesRegex(SignalError,"GEOMETRY_MISSING"):
            fixed_station_geometry(MeasurementInputs(laser_position_world_m=(0.,0.,0.)),allow_upright_assumption=True)


class QualityTests(unittest.TestCase):
    def test_global_to_local_window(self):
        self.assertEqual(candidate_window(recording()),(0,4000))

    def test_boundary_not_silently_clamped(self):
        r=recording();r.manifest["pointCycle"]["handoff"]["entryConfirmedSampleIndex"]=900
        with self.assertRaisesRegex(SignalError,"PASS_BOUNDARY_OUTSIDE_RECORDING"):candidate_window(r)
        b=analyze_recording(r)
        self.assertEqual(b["status"],"blocked");self.assertEqual(len(r.velocity_m_s),4000)

    def test_clock_mismatch_refused(self):
        r=recording();r.manifest["pointCycle"]["handoff"]["sampleClock"]="other"
        with self.assertRaisesRegex(SignalError,"CLOCK_REFERENCE_MISMATCH"):candidate_window(r)

    def test_nonfinite_and_overrange_split_segments(self):
        r=recording();v=r.velocity_m_s.copy();v[100]=np.nan;o=r.overrange.copy();o[200]=1
        r=replace(r,velocity_m_s=v,overrange=o)
        segments,_=extract_segments(r,AnalysisConfig())
        self.assertEqual([(s.source_start,s.source_end) for s in segments],[(0,100),(101,200),(201,4000)])

    def test_time_gap_is_not_interpolated(self):
        r=recording();t=r.time_s.copy();t[1000:]+=.01;r=replace(r,time_s=t)
        segments,events=extract_segments(r,AnalysisConfig())
        self.assertEqual([len(s.values_m_s) for s in segments],[1000,3000])
        self.assertIn("DATA_GAP",[e["code"] for e in events])

    def test_zero_rssi_default_marks_only(self):
        r=recording();s=r.rssi_percent.copy();s[200:210]=0;r=replace(r,rssi_percent=s)
        segments,events=extract_segments(r,AnalysisConfig())
        self.assertEqual(len(segments),1);self.assertEqual(len(segments[0].values_m_s),4000)
        self.assertEqual(events[0]["code"],"RSSI_ZERO_SUSPECT")

    def test_hard_rssi_gate_requires_rule_and_alignment(self):
        r=recording();s=r.rssi_percent.copy();s[200:210]=0;r=replace(r,rssi_percent=s)
        with self.assertRaisesRegex(SignalError,"RSSI_RULE_UNCALIBRATED"):
            extract_segments(r,AnalysisConfig(rssi_min_percent=1.))
        segments,_=extract_segments(r,AnalysisConfig(rssi_min_percent=1.,rssi_rule_verified=True,rssi_alignment_verified=True))
        self.assertEqual([(s.source_start,s.source_end) for s in segments],[(0,200),(210,4000)])

    def test_guard_expands_invalid_only(self):
        r=recording();o=r.overrange.copy();o[200]=1;r=replace(r,overrange=o)
        segments,_=extract_segments(r,AnalysisConfig(quality_guard_seconds=.001))
        self.assertEqual([(s.source_start,s.source_end) for s in segments],[(0,196),(205,4000)])


class DSPTests(unittest.TestCase):
    def test_feature_definitions(self):
        s=segment();f=features(s)
        self.assertAlmostEqual(f["half_peak_to_peak_m_s"],.002,places=12)
        self.assertAlmostEqual(f["rms_m_s"],math.sqrt(.01**2+.002**2/2),places=12)

    def test_fft_amplitude_and_zero_padding(self):
        s=segment();a=spectra(s);b=spectra(s,nfft=8000)
        i=np.argmin(abs(a["fft_frequency_hz"]-200));j=np.argmin(abs(b["fft_frequency_hz"]-200))
        self.assertAlmostEqual(a["fft_peak_amplitude_m_s"][i],.002,places=12)
        self.assertAlmostEqual(b["fft_peak_amplitude_m_s"][j],.002,places=12)
        self.assertEqual(b["real_observation_seconds"],a["real_observation_seconds"])

    def test_psd_energy_uses_window_weighted_definition(self):
        s=segment();p=spectra(s);w=.5-.5*np.cos(2*np.pi*np.arange(4000)/4000)
        expected=float(np.sum((s.values_m_s*w)**2)/np.sum(w*w))
        actual=float(np.sum(p["psd_m2_s2_per_hz"])*p["psd_grid_spacing_hz"])
        self.assertAlmostEqual(actual,expected,places=12)

    def test_band_rms_and_short_welch(self):
        s=segment();p=spectra(s,band_hz=(180,220))
        self.assertAlmostEqual(p["band_rms_m_s"],.002/math.sqrt(2),places=12)
        with self.assertRaisesRegex(SignalError,"INSUFFICIENT_OBSERVATION"):spectra(s,welch_window_seconds=2.)

    def test_filter_none_does_not_change_values(self):
        s=segment();y,g,p=filter_continuous(s,FilterSpec())
        np.testing.assert_array_equal(y,s.values_m_s);self.assertEqual(g,0)

    def test_lowpass_reduces_out_of_band_component(self):
        t=np.arange(4000)/4000;target=.002*np.sin(2*np.pi*200*t)
        s=segment(recording(values=target+.001*np.sin(2*np.pi*1400*t)))
        y,g,p=filter_continuous(s,FilterSpec("lowpass",(500.,),4,.1))
        self.assertLess(np.sqrt(np.mean((y[g:-g]-target[g:-g])**2)),.00002)
        self.assertEqual(p["passes"],2)

    def test_filter_length_and_edge_failures(self):
        s=segment(recording(n=10,fs=100))
        with self.assertRaisesRegex(SignalError,"FILTER_SEGMENT_TOO_SHORT"):filter_continuous(s,FilterSpec("lowpass",(10.,),4,0.))
        with self.assertRaisesRegex(SignalError,"FILTER_EDGE_EXHAUSTED"):filter_continuous(segment(),FilterSpec("lowpass",(500.,),4,.5))

    def test_notch_requires_evidence(self):
        with self.assertRaisesRegex(SignalError,"NOTCH_EVIDENCE_REQUIRED"):
            filter_continuous(segment(),FilterSpec("notch",(50.,),4,.1,30.))

    def test_spikes_are_marked_not_deleted_despite_positive_rssi(self):
        r=recording();v=r.velocity_m_s.copy();v[1000]+=.05;s=segment(replace(r,velocity_m_s=v))
        before=s.values_m_s.copy();events,_=spike_candidates(s)
        self.assertTrue(any(e["peak_source_index"]==1000 for e in events))
        self.assertEqual(events[0]["cause"],"undetermined");self.assertEqual(events[0]["peak_rssi_percent"],30.)
        np.testing.assert_array_equal(s.values_m_s,before)

    def test_zero_mad_does_not_generate_infinite_threshold(self):
        s=segment(recording(values=np.zeros(4000)))
        self.assertEqual(spike_candidates(s),([],["SPIKE_SCALE_UNDEFINED"]))

    def test_stft_window_is_bounded_by_real_segment(self):
        p=time_frequency(segment(),window_seconds=.1)
        self.assertAlmostEqual(p["time_s"][0],.05)
        with self.assertRaisesRegex(SignalError,"INSUFFICIENT_OBSERVATION"):time_frequency(segment(),window_seconds=2.)

    def test_bandlimited_kinematics(self):
        t=np.arange(4000)/4000;s=segment(recording(values=.002*np.sin(2*np.pi*200*t)))
        p=bandlimited_kinematics(s,band_hz=(180.,220.),edge_guard_seconds=.1)
        expected_disp=-.002/(2*np.pi*200)*np.cos(2*np.pi*200*p["time_s"])
        expected_acc=.002*(2*np.pi*200)*np.cos(2*np.pi*200*p["time_s"])
        np.testing.assert_allclose(p["displacement_m"],expected_disp,atol=1e-15)
        np.testing.assert_allclose(p["acceleration_m_s2"],expected_acc,atol=1e-10)
        self.assertFalse(p["absolute_displacement_available"])

    def test_envelope_has_explicit_carrier_band(self):
        t=np.arange(4000)/4000;env=.002*(1+.5*np.sin(2*np.pi*20*t))
        p=envelope_analysis(segment(recording(values=env*np.sin(2*np.pi*500*t))),passband_hz=(400.,600.),edge_guard_seconds=.1)
        self.assertLess(np.sqrt(np.mean((p["envelope_m_s"]-env[400:-400])**2)),.00001)

    def test_display_objects_are_rejected(self):
        p=DisplayPreview(np.zeros(10),4000,(),(),8,2)
        for fn in (features,spectra):
            with self.assertRaisesRegex(SignalError,"SYNTHETIC_INPUT_FORBIDDEN"):fn(p)


class PipelineTests(unittest.TestCase):
    def test_unknown_geometry_keeps_los_results(self):
        b=analyze_recording(recording());r=representative(b)
        self.assertEqual(r.basis,"los");self.assertEqual(b["status"],"ready")
        self.assertIn("GEOMETRY_CONVENTION_REQUIRED",b["issues"])

    def test_runtime_dimensions_change_projection_result(self):
        c=AnalysisConfig(allow_upright_geometry_assumption=True,projection="axial_equivalent",min_abs_projection=.01,max_projection_gain=10.)
        a=representative(analyze_recording(recording(angle=180),dict(hub_height_m=70.,laser_height_m=2.),c))
        b=representative(analyze_recording(recording(angle=180),dict(hub_height_m=140.,laser_height_m=3.),c))
        self.assertNotEqual(a.result_id,b.result_id)
        self.assertNotEqual(a.features["rms_m_s"],b.features["rms_m_s"])

    def test_missing_projection_limits_does_not_mislabel_los(self):
        r=representative(analyze_recording(recording(),config=AnalysisConfig(allow_upright_geometry_assumption=True,projection="axial_equivalent")))
        self.assertEqual(r.basis,"los");self.assertEqual(r.status["projection"]["state"],"blocked")
        self.assertIn("PROJECTION_LIMITS_UNCONFIGURED",r.status["issues"])

    def test_turntable_speed_is_never_a_rotor_reference(self):
        r=representative(analyze_recording(recording(),config=AnalysisConfig(rotation_mode="apply_constant",instrument_sign=1)))
        self.assertIn("RPM_REFERENCE_MISSING",r.status["issues"])
        self.assertNotIn("nominal_rotation_model",r.layers)

    def test_measured_rotation_constant_is_compensated(self):
        r=recording(angle=90);g=fixed_station_geometry(read_measurement_inputs(r.manifest),allow_upright_assumption=True)
        nominal=g.rotational_los_per_rad_s_m*12*2*np.pi/60
        y=nominal+.002*np.sin(2*np.pi*200*r.time_s);r=replace(r,velocity_m_s=y)
        c=AnalysisConfig(allow_upright_geometry_assumption=True,instrument_sign=1,rotation_mode="apply_constant",background="none")
        result=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"measured_record_mean",12.)))
        self.assertAlmostEqual(result.features["mean_m_s"],0.,places=11)
        self.assertAlmostEqual(result.features["rms_m_s"],.002/math.sqrt(2),places=11)
        self.assertEqual(result.status["rotation"]["state"],"applied_constant_approx")

    def test_manual_estimate_cannot_be_synchronized_application(self):
        r=recording(angle=90);c=AnalysisConfig(allow_upright_geometry_assumption=True,instrument_sign=1,rotation_mode="apply_constant")
        a=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"manual_estimate",12.)))
        self.assertEqual(a.status["rotation"]["state"],"blocked")

    def test_dynamic_rpm_and_reference_time_alignment(self):
        r=recording(angle=90);g=fixed_station_geometry(read_measurement_inputs(r.manifest),allow_upright_assumption=True)
        rpm=12+np.sin(2*np.pi*3*r.time_s)
        target=.002*np.sin(2*np.pi*200*r.time_s)
        r=replace(r,velocity_m_s=target+rpm*(2*np.pi/60)*g.rotational_los_per_rad_s_m)
        c=AnalysisConfig(allow_upright_geometry_assumption=True,instrument_sign=1,rotation_mode="apply_synchronized",background="none")
        a=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"synchronized_tach",rpm,r.time_s)))
        np.testing.assert_allclose(a.layers["los_residual"],target,atol=1e-13)
        b=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"synchronized_tach",rpm,r.time_s+.001)))
        self.assertIn("RPM_NOT_SYNCHRONIZED",b.status["issues"])

    def test_reference_change_invalidates_result_identity(self):
        r=recording(angle=90);c=AnalysisConfig(allow_upright_geometry_assumption=True,instrument_sign=1,rotation_mode="apply_constant")
        a=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"measured_record_mean",12.)))
        b=representative(analyze_recording(r,config=c,rotation_reference=RotationReference(r.recording_id,"measured_record_mean",14.)))
        self.assertNotEqual(a.result_id,b.result_id)
        np.testing.assert_allclose(a.layers["los_residual"],b.layers["los_residual"],atol=1e-12)
        self.assertIn("BACKGROUND_NOT_UNIQUE",a.status["issues"])

    def test_filter_failure_does_not_return_unfiltered_features_as_filtered(self):
        b=analyze_recording(recording(),config=AnalysisConfig(filter=FilterSpec("lowpass",(500.,),4,.5)))
        r=b["segments"][0];self.assertEqual(r.features,{})
        self.assertNotIn("filtered_residual",r.layers)
        with self.assertRaisesRegex(SignalError,"ANALYSIS_UNAVAILABLE"):r.analysis_input()

    def test_fixed_core_uses_only_real_samples(self):
        b=analyze_recording(recording(),config=AnalysisConfig(core_window_seconds=.06))
        r=representative(b);self.assertEqual(r.features["sample_count"],240)
        self.assertEqual(r.segment.source_start,1880)
        self.assertFalse(b["source_quality"]["formal_quality_certified_by_library"])


class JoinAndAggregateTests(unittest.TestCase):
    def join_config(self):
        return JoinConfig(.002,.004,.0002,25000.,12,amplitude_guard_factor=10.,slope_guard_factor=20.)

    def point_results(self):
        return [representative(analyze_recording(recording(str(a),a,n=1500,fs=25000),config=AnalysisConfig())) for a in (0,90,180,270)]

    def test_join_preserves_discrete_increments_and_inputs(self):
        fs=25000;t=np.arange(1500)/fs;L=.001*np.sin(2*np.pi*200*t);R=.001*np.sin(2*np.pi*200*t+.4)
        before_L,before_R=L.copy(),R.copy();b,p=join_arrays(L,R,fs,self.join_config())
        self.assertEqual(len(b),50)
        self.assertAlmostEqual((b[0]-L[-1])-(L[-1]-L[-2]),0.,places=15)
        self.assertAlmostEqual((R[0]-b[-1])-(R[1]-R[0]),0.,places=15)
        np.testing.assert_array_equal(L,before_L);np.testing.assert_array_equal(R,before_R)

    def test_short_flat_and_overlapping_caps_refused(self):
        c=self.join_config()
        for L,R,config in [(np.ones(3),np.ones(3),c),(np.ones(1500),np.ones(1500),c),
            (np.arange(1500.),np.arange(1500.),replace(c,cap_seconds=.002))]:
            with self.assertRaisesRegex(SignalError,"JOIN_PREVIEW_UNSUPPORTED"):join_arrays(L,R,25000,config)

    def test_preview_source_blocks_are_unchanged_and_not_analyzable(self):
        results=self.point_results()
        before=[r.features.copy() for r in results]
        p=build_point_preview(results,expected_azimuths=(0.,90.,180.,270.),config=self.join_config())
        self.assertEqual(p.measured_samples,6000);self.assertEqual(p.synthetic_samples,150)
        for block,r in zip([b for b in p.blocks if b["kind"]=="measured_processed"],results):
            a=block["display_start_sample"];np.testing.assert_array_equal(p.values_m_s[a:a+block["samples"]],r.analysis_input().values_m_s)
        self.assertEqual(before,[r.features for r in results])
        with self.assertRaisesRegex(SignalError,"SYNTHETIC_INPUT_FORBIDDEN"):spectra(p)

    def test_missing_station_and_mixed_point_refused(self):
        results=self.point_results()
        with self.assertRaisesRegex(SignalError,"JOIN_PREVIEW_UNSUPPORTED"):
            build_point_preview(results[:3],expected_azimuths=(0.,90.,180.,270.),config=self.join_config())
        results[-1].parameters["object"]["point"]="different_point"
        with self.assertRaisesRegex(SignalError,"AGGREGATION_BASIS_MISMATCH"):
            build_point_preview(results,expected_azimuths=(0.,90.,180.,270.),config=self.join_config())

    def test_two_level_equal_weight_not_all_pass_weight(self):
        config=AnalysisConfig(background="none")
        bundles=[analyze_recording(recording(rid,a,amp),config=config) for rid,a,amp in [("a",0,.001),("b",0,.003),("c",90,.008)]]
        p=aggregate_points(bundles)[0]
        self.assertAlmostEqual(p["mean_half_peak_to_peak_m_s"],.005,places=12)
        self.assertEqual(p["azimuth_count"],2)
        self.assertIsNone(p["azimuth_results"][1]["repeat_amplitude_sample_std_m_s"])
        self.assertIsNotNone(p["cross_azimuth_psd"])

    def test_exact_duplicate_does_not_gain_weight(self):
        b=analyze_recording(recording());p=aggregate_points([b,b])[0]
        self.assertEqual(p["azimuth_results"][0]["pass_count"],1)

    def test_conflicting_versions_of_same_capture_require_selection(self):
        a=analyze_recording(recording(),config=AnalysisConfig(background="none"))
        b=analyze_recording(recording(),config=AnalysisConfig(background="linear"))
        with self.assertRaisesRegex(SignalError,"DUPLICATE_CAPTURE_REQUIRES_SELECTION"):aggregate_points([a,b])

    def test_incomparable_psd_does_not_get_zero_filled(self):
        a=analyze_recording(recording("a",0,n=4000));b=analyze_recording(recording("b",90,n=3000))
        p=aggregate_points([a,b])[0]
        self.assertIsNone(p["cross_azimuth_psd"])
        self.assertEqual(p["psd_reason"],"SPECTRAL_PROFILE_MISMATCH")


if __name__=="__main__":
    unittest.main()
