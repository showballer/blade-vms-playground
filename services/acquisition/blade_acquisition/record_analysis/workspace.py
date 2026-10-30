"""Desktop application policy around the unchanged reference implementation.

Automatic choices are numerical/resource policies, never inferred modal bands.
"""
from __future__ import annotations
from dataclasses import replace,asdict
import hashlib,json,math
import numpy as np
from scipy import signal
from .reference.models import FilterSpec,require_real
from .reference.geometry import SignalError
from .reference.quality import candidate_window,extract_segments,runs
from .reference import analyze_recording
from .reference.dsp import spectra
from .reference.cli import json_safe

VERSION='desktop-workspace-1.4.0'
DEFAULT={'detrend':'linear','filterKind':'none','lowHz':None,'highHz':None,'filterOrder':4,'window':'hann'}

def options(value):
 if not isinstance(value,dict) or set(value)-set(DEFAULT):raise SignalError('INVALID_CONFIG','Unsupported desktop algorithm options')
 out={**DEFAULT,**value}
 if out['detrend'] not in ('none','constant','linear') or out['filterKind'] not in ('none','lowpass','highpass','bandpass') or out['window'] not in ('hann','hamming','blackman','boxcar'):raise SignalError('INVALID_CONFIG','Unknown detrend, filter or window')
 if type(out['filterOrder']) is not int or not 1<=out['filterOrder']<=12:raise SignalError('INVALID_CONFIG','Filter order must be an integer from 1 to 12')
 for key in ('lowHz','highHz'):
  v=out[key]
  if v is not None and (isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0):raise SignalError('INVALID_CONFIG',key+' must be a positive frequency')
 if out['filterKind'] in ('lowpass','bandpass') and out['highHz'] is None or out['filterKind'] in ('highpass','bandpass') and out['lowHz'] is None:raise SignalError('INVALID_CONFIG','Filter cutoff is required')
 if out['filterKind']=='bandpass' and out['lowHz']>=out['highHz']:raise SignalError('INVALID_CONFIG','Bandpass low cutoff must be below high cutoff')
 return out

def filter_spec(settings,fs):
 kind=settings['filterKind']
 if kind=='none':return FilterSpec()
 cutoffs=tuple([settings['lowHz'],settings['highHz']] if kind=='bandpass' else [settings['lowHz'] if kind=='highpass' else settings['highHz']])
 if not all(0<v<fs/2 for v in cutoffs):raise SignalError('INVALID_CONFIG',f'Filter cutoff {cutoffs} Hz must be below Nyquist {fs/2:g} Hz')
 sos=signal.butter(settings['filterOrder'],cutoffs if kind=='bandpass' else cutoffs[0],btype=kind,fs=fs,output='sos')
 poles=signal.sos2zpk(sos)[1];radius=float(np.max(np.abs(poles)))
 if not 0<radius<1:raise SignalError('INVALID_CONFIG','Filter is numerically unstable at this sample rate')
 # A 1e-4 pole-envelope tail plus the reference pad is retained as excluded edge.
 guard=max(3*(2*len(sos)+1),int(math.ceil(math.log(1e-4)/math.log(radius))))
 return FilterSpec(kind=kind,cutoffs_hz=cutoffs,order=settings['filterOrder'],edge_guard_seconds=guard/fs)

def quality_record(raw):
 """Do not reject normal zero crossings or large genuine impacts by amplitude."""
 try:start,end=candidate_window(raw)
 except (ValueError,TypeError):return raw,[]
 m=raw.manifest;mask=np.asarray(raw.overrange).copy();events=[]
 intervals=m.get('qualityIntervals') or []
 if isinstance(intervals,list):
  for item in intervals:
   if not isinstance(item,dict) or item.get('verified') is not True or item.get('sampleClock')!='recording_local' or item.get('reason') not in ('DEVICE_INVALID','DECODER_INVALID','SIGNAL_LOST'):continue
   a,b=item.get('startSample'),item.get('endSampleExclusive')
   if type(a) is not int or type(b) is not int or not 0<=a<b<=len(mask):continue
   a,b=max(start,a),min(end,b)
   if a<b:mask[a:b]=1;events.append({'code':item['reason'],'source_start':a,'source_end':b,'excluded':True,'basis':'saved_verified_device_interval'})
 y=raw.velocity_m_s[start:end];threshold=max(8,int(math.ceil(raw.sample_rate_hz*.001)))
 equal=np.r_[False,np.isfinite(y[1:])&np.isfinite(y[:-1])&(y[1:]==y[:-1])]
 verified=m.get('qualityRules') or {};trusted=(verified.get('rssiAlignmentVerified') is True and verified.get('lossRuleVerified') is True)
 for a,b in runs(equal):
  a=max(0,a-1)
  if b-a<threshold:continue
  lo,hi=start+a,start+b;zero=bool(np.all(y[a:b]==0));lost=trusted and np.all(np.isfinite(raw.rssi_percent[lo:hi])&(raw.rssi_percent[lo:hi]<=0))
  code='ZERO_RUN_CONFIRMED_INVALID' if zero and lost else 'FROZEN_RUN_CONFIRMED_INVALID' if lost else 'ZERO_RUN_SUSPECT' if zero else 'FROZEN_RUN_SUSPECT'
  if lost:mask[lo:hi]=1
  events.append({'code':code,'source_start':lo,'source_end':hi,'excluded':bool(lost),'basis':'verified_saved_loss_rule' if lost else 'candidate_only_samples_retained'})
 return replace(raw,overrange=mask),events

def policy(load,ids,settings,base):
 durations=[];rates=[];details=[]
 for rid in ids:
  try:
   raw,_=quality_record(load(rid));spec=filter_spec(settings,raw.sample_rate_hz)
   segs,_=extract_segments(raw,base);guard=int(round((spec.edge_guard_seconds or 0)*raw.sample_rate_hz))
   n=min((len(s.values_m_s)-2*guard for s in segs if len(s.values_m_s)>2*guard+3),default=0)
   if n:durations.append(n/raw.sample_rate_hz);rates.append(raw.sample_rate_hz)
   details.append({'recordingId':rid,'sampleRateHz':raw.sample_rate_hz,'minimumUsableSamples':n,'filterGuardSamplesEachSide':guard})
  except (OSError,ValueError,TypeError) as exc:details.append({'recordingId':rid,'reason':str(exc)})
 if not durations:return {'version':VERSION,'sharedWelchSeconds':None,'automaticBandHz':None,'records':details}
 seconds=min(durations)/2;fs=min(rates);count=max(2,2**int(math.floor(math.log2(max(2,min(32768,seconds*fs))))))
 seconds=count/fs
 return {'version':VERSION,'sharedWelchSeconds':seconds,'automaticBandHz':[1/seconds,min(rates)/2] if 1/seconds<min(rates)/2 else None,'records':details,'bandMeaning':'resolved_non_DC_to_common_Nyquist_not_a_modal_or_carrier_band'}

def window_spectra(real,window,welch_seconds,band=None):
 real=require_real(real)
 if window=='hann':return spectra(real,welch_window_seconds=welch_seconds,band_hz=band)
 y=real.values_m_s;fs=real.sample_rate_hz;n=len(y);w=signal.get_window(window,n,fftbins=True)
 amplitude=abs(np.fft.rfft(w*y))/w.sum();amplitude[1:-1 if n%2==0 else None]*=2
 count=int(round(welch_seconds*fs)) if welch_seconds else n
 if not 2<=count<=n:raise SignalError('INSUFFICIENT_OBSERVATION','Welch window exceeds the real continuous segment')
 f,p=signal.welch(y,fs,window=window,nperseg=count,noverlap=count//2,detrend=False,scaling='density')
 out=dict(fft_frequency_hz=np.fft.rfftfreq(n,1/fs),fft_peak_amplitude_m_s=amplitude,psd_frequency_hz=f,psd_m2_s2_per_hz=p,psd_method='welch',psd_window_samples=count,psd_window_seconds=count/fs,psd_grid_spacing_hz=fs/count,fft_grid_spacing_hz=fs/n,real_observation_seconds=n/fs,zero_padding_samples=0,window='periodic_'+window,amplitude_unit='m/s (peak)',psd_unit='(m/s)^2/Hz',detrend='none_after_declared_processing')
 if band:
  lo,hi=band;selected=(f>=lo)&(f<=hi)
  if not 0<=lo<hi<=fs/2 or not np.any(selected):raise SignalError('INVALID_SPECTRAL_CONFIG','No resolved frequency bin in band')
  power=float(p[selected].sum()*fs/count);out.update(band_hz=list(band),band_mean_square_m2_s2=power,band_rms_m_s=math.sqrt(max(0,power)),band_integration='rectangular_selected_frequency_bins',evaluated_bin_centers_hz=[float(f[selected][0]),float(f[selected][-1])])
 return out

def analyze(raw,base,settings,plan,window=None):
 original=raw;raw,events=quality_record(raw)
 spec=filter_spec(settings,raw.sample_rate_hz)
 config=replace(base,background=settings['detrend'],filter=spec,welch_window_seconds=plan['sharedWelchSeconds'])
 bundle=analyze_recording(raw,config=config,explicit_window=window)
 bundle['quality_events'].extend(events)
 for s in bundle['segments']:
  if s.status.get('analysis_state')!='ready':continue
  try:s.spectrum=window_spectra(s.analysis_input(),settings['window'],config.welch_window_seconds)
  except SignalError as exc:s.spectrum={};s.status.update(spectrum_state='blocked',spectrum_message=str(exc));s.status['issues'].append(exc.code)
  n=len(s.analysis_input().values_m_s);stft=max(2,2**int(math.floor(math.log2(max(2,min(n//4,4096))))))
  s.parameters['desktop_workspace']={'version':VERSION,'algorithmOptions':settings,'automatic':{'sourceRange':[s.segment.source_start,s.segment.source_end],'analysisRange':[s.analysis_start,s.analysis_end],'fftSamples':n,'zeroPaddingSamples':0,'stftWindowSamples':stft,'stftWindowSeconds':stft/raw.sample_rate_hz,'welchWindowSeconds':config.welch_window_seconds,'analysisBandHz':plan['automaticBandHz'],'filterEdgeGuardSeconds':spec.edge_guard_seconds or 0,'window':settings['window']},'rawSourceHash':original.source_hash}
  s.result_id=hashlib.sha256(json.dumps({'referenceId':s.result_id,'desktopOptions':settings,'automatic':s.parameters['desktop_workspace']},sort_keys=True).encode()).hexdigest()
 bundle['representative']=max((s for s in bundle['segments'] if s.status.get('analysis_state')=='ready'),key=lambda s:len(s.analysis_input().values_m_s),default=None)
 if bundle['representative'] is not None:bundle['representative']=bundle['representative'].result_id
 return bundle

def comparison(bundle,m,original):
 key={'frame':{k:(bundle.get('measurement_inputs') or {}).get(k) for k in ('shaft_axis_world','laser_position_world_m','hub_position_world_m')},'calibration':{k:((m.get('turntable') or {}).get('config') or {}).get('geometry',{}).get(k) for k in ('rotationDirection','axis1Sign','axis2Sign','pitchAngleScale','yawAngleScale')},'referenceSignature':(m.get('pointCycle') or {}).get('referenceSignature'),'model':(bundle.get('geometry') or {}).get('model'),'assumptions':(bundle.get('geometry') or {}).get('assumptions')}
 original['geometryComparisonKey']=hashlib.sha256(json.dumps(key,sort_keys=True).encode()).hexdigest();original['geometryComparisonSnapshot']['perRecordGeometryRetained']=True
 return original

def auto_stft(result):
 real=result.analysis_input();saved=result.parameters['desktop_workspace'];n=saved['automatic']['stftWindowSamples']
 if n<4 or len(real.values_m_s)//(n//2)*(n//2+1)>4_000_000:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','Continuous segment cannot support a bounded STFT')
 f,t,z=signal.spectrogram(real.values_m_s,real.sample_rate_hz,window=saved['algorithmOptions']['window'],nperseg=n,noverlap=n//2,detrend=False,scaling='density',mode='psd')
 fi=np.unique(np.linspace(0,len(f)-1,min(128,len(f)),dtype=int));ti=np.unique(np.linspace(0,len(t)-1,min(160,len(t)),dtype=int))
 return {'frequency_hz':f[fi],'time_s':t[ti]+real.time_s[0],'psd_m2_s2_per_hz':z[np.ix_(fi,ti)],'window_samples':n,'window':saved['algorithmOptions']['window'],'unit':'(m/s)^2/Hz','display_only':True}

def automatic_preview_config(results):
 sizes=[len(r.analysis_input().values_m_s) for r in results];fs=results[0].segment.sample_rate_hz
 smallest=min(sizes);context=max(32,min(2048,smallest//4));bridge=max(8,int(smallest*.02));cap=max(2,bridge//8)
 # Every duration derives from this group's real sample count/rate, not lab geometry.
 down=max(1,int(math.ceil(context/256)));model_fs=fs/down;order=min(12,max(1,int(context/down)//8))
 return dict(duration_seconds=bridge/fs,context_seconds=context/fs,cap_seconds=cap/fs,model_sample_rate_hz=model_fs,ar_order=order,prediction_decay_seconds=context/fs,ridge_relative=.003,max_pole_radius=.995,amplitude_guard_factor=3.,slope_guard_factor=3.)
