"""One versioned numerical contract for both transports. No UI/HTTP defaults."""
from __future__ import annotations
import copy,hashlib,json,math
VERSION='unified-analysis-2.2.2'
LIMITS={'recordsPerJob':200,'samplesPerRecord':30_000_000,'samplesPerJob':40_000_000,'modalChannels':16,'modalSamples':2_000_000,'packageBytes':256*1024*1024}
EDGE={'version':'pass-boundaries-2.2.1','windowSeconds':.002,'persistenceSeconds':.006,'edgeProximitySeconds':.025,'stepSigma':10.,'stepDifferenceRatio':8.,'trendSigma':20.,'trendMonotonicFraction':.85,'flatSigma':.25,'frozenSeconds':.005,'stepRefinement':'two_plateau_absolute_error','transitionUncertainty':'adjacent_detection_windows_require_review','evidence':'pass_events_and_persistent_plateau; statistics_only_requires_review'}
GEOMETRY={'direction':'los','uprightAssumption':False,'minAbsProjection':None,'maxProjectionGain':None,'distanceMeaning':'unknown','inputOverrides':None,'recordOverrides':{},'observationModel':'unknown','axialDominanceDeclared':False,'instrumentSign':None,'signSource':None}
DEFAULT={'detrend':'linear','filterKind':'none','lowHz':None,'highHz':None,'filterOrder':4,'window':'hann','geometry':GEOMETRY,'targetBandMode':'preview','targetBandHz':None,'targetBandSource':None}
PREVIEW_BAND={'version':'response-preview-band-1','preferredHz':[100.,20000.],'meaning':'descriptive_response_only_not_identified_modal_band','lowRatePolicy':'upper_at_Nyquist_lower_at_min_100_or_one_tenth_Nyquist'}
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
def contract():return {'version':VERSION,'defaults':copy.deepcopy(DEFAULT),'edgeRules':dict(EDGE),'responsePreviewBand':copy.deepcopy(PREVIEW_BAND),'limits':dict(LIMITS),'fft':'real_N_no_padding','weights':'independent_capture_then_equal_azimuth_power','bandRms':'sqrt(integral(equal_azimuth_mean_PSD))','targetBandRequired':True,'fixedCoreWindowAllowed':False,'geometryLayers':['los_residual','axial_equivalent_residual'],'reviewVersion':'quality-review-2.2.0'}
def angle(raw,planned,tolerance):
 if isinstance(raw,bool) or not isinstance(raw,(int,float)) or not math.isfinite(raw):return {'status':'unknown','original':raw,'normalized':None,'mapped':None}
 normalized=float(raw)%360
 if not planned:return {'status':'plan_unknown','original':raw,'normalized':normalized,'mapped':normalized}
 if isinstance(tolerance,bool) or not isinstance(tolerance,(int,float)) or not math.isfinite(tolerance) or not 0<=tolerance<180:return {'status':'tolerance_unknown','original':raw,'normalized':normalized,'mapped':None}
 choices=sorted(set(float(p)%360 for p in planned));hits=[p for p in choices if abs((normalized-p+180)%360-180)<=tolerance]
 return {'status':'mapped' if len(hits)==1 else 'conflict' if hits else 'outside_plan','original':raw,'normalized':normalized,'mapped':hits[0] if len(hits)==1 else None,'candidates':hits,'tolerance':tolerance}
def identities(manifest):
 pc=manifest.get('pointCycle') or {};binding=manifest.get('applicationBinding') or {};ids=manifest.get('entityIds') or binding.get('entityIds')
 if isinstance(ids,dict) and all(isinstance(ids.get(k),str) and ids[k] for k in ('farmId','turbineId','bladeId','positionId')):return {**ids,'verified':pc.get('identityVerified') is True or binding.get('identityVerified') is True,'source':'saved_entity_ids'}
 # Legacy labels are explicitly a diagnostic namespace, not an entity assertion.
 scope=pc.get('collectionId') or pc.get('sessionId') or manifest.get('captureSessionId') or manifest.get('id')
 return {k:digest([scope,k,v])[:24] for k,v in {'farmId':manifest.get('windFarm'),'turbineId':manifest.get('turbine'),'bladeId':pc.get('bladeId'),'positionId':pc.get('radialPointName')}.items()}|{'verified':False,'source':'legacy_diagnostic_namespace','batchId':scope}
