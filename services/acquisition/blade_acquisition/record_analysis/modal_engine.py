"""Real modal estimators. Inputs are saved continuous datasets, never display joins.

CSD convention: scipy.signal.csd(force,response) = conj(F)*Y.
SSI covariance/Hankel and pole equations follow execution spec V2.2 §3.4.
"""
from __future__ import annotations
import math
import numpy as np
from scipy import signal,linalg,optimize,stats
from .reference.geometry import SignalError
from .plan import LIMITS
VERSION='modal-methods-2.2.0'
METHODS={
 'decay':{'name':'自由衰减／对数减量','minimumPeaks':6,'minimumEnvelopeR2':.95,'maximumPeriodCV':.08,'maximumModelResidualRatio':.25},
 'frf':{'name':'FRF 半功率带宽','minimumCoherence':.8,'minimumResolvedBandwidthBins':3,'maximumRelativeModelResidual':.2,'maximumDamping':.2},
 'ssi_cov':{'name':'工作模态 SSI-COV','frequencyRelativeTolerance':.015,'dampingRelativeTolerance':.3,'minimumMAC':.95,'minimumStableOrders':3,'maximumDamping':.2,'stationaryEnergyRatio':4.,'minimumSamplesPerCovarianceLag':20},
}
def capabilities():return {'engineVersion':VERSION,'methods':[{'id':k,**v,'implemented':True,'validation':'known-system numerical validation; field applicability requires qualified input'} for k,v in METHODS.items()],'limits':LIMITS,'phaseRecoveryAvailable':False,'damageAlgorithm':'algorithm_not_connected'}
def validate(data):
 if not isinstance(data,dict) or data.get('schemaVersion')!='modal-input-1':raise SignalError('INVALID_MODAL_INPUT','Expected modal-input-1 dataset')
 if data.get('synthetic') or data.get('analysis_eligible') is False or data.get('kind')=='display_preview' or data.get('containsSynthetic'):raise SignalError('SYNTHETIC_INPUT_FORBIDDEN','Display transitions are not modal inputs')
 t=np.asarray(data.get('time_s'),dtype=float);channels=data.get('channels');meta=data.get('evidence') or {}
 if t.ndim!=1 or not 32<=len(t)<=LIMITS['modalSamples'] or not np.all(np.isfinite(t)):raise SignalError('INVALID_MODAL_INPUT','Bounded finite real time series required')
 if not isinstance(channels,list) or not 1<=len(channels)<=LIMITS['modalChannels'] or len({c.get('id') for c in channels})!=len(channels):raise SignalError('INVALID_MODAL_INPUT','Distinct mapped channels required')
 dt=np.diff(t)
 if np.any(dt<=0) or not np.allclose(dt,np.median(dt),rtol=1e-6,atol=max(1e-12,float(np.median(dt))*1e-7)):raise SignalError('MODAL_CLOCK_GAP','All channels require one continuous regular clock')
 y=np.array([c.get('values') for c in channels],dtype=float).T
 if y.shape!=(len(t),len(channels)) or not np.all(np.isfinite(y)):raise SignalError('MODAL_DATA_GAP','Channel length or finite sample validation failed')
 expected={'displacement':'m','velocity':'m/s','acceleration':'m/s^2','force':'N'}
 for c in channels:
  if c.get('unit')!=expected.get(c.get('quantity')) or c.get('role') not in ('response','excitation') or not c.get('calibrationSource') or not c.get('pointId'):raise SignalError('MODAL_CHANNEL_METADATA','Channel role, SI units, point and calibration source required')
 if any(not isinstance(c.get('id'),str) or not c['id'] or not isinstance(c.get('pointId'),str) for c in channels):raise SignalError('MODAL_CHANNEL_METADATA','Stable channel and point identifiers must be strings')
 if len(channels)>1 and (meta.get('synchronization')!='common_sample_clock' or not meta.get('clockSource')):raise SignalError('MODAL_SYNCHRONIZATION_REQUIRED','Multiple channel names are not synchronization evidence')
 return t-t[0],y,1/float(np.median(dt)),channels,meta

def decay(t,y,fs,channels,evidence,cancel=lambda:None):
 cfg=METHODS['decay'];indices=[i for i,c in enumerate(channels) if c['role']=='response']
 if len(indices)!=1 or evidence.get('excitationRemoved') is not True or not evidence.get('excitationRemovalSource'):raise SignalError('FREE_DECAY_EVIDENCE_REQUIRED','One response and documented removal of excitation required')
 x=y[:,indices[0]].copy();offset=float(np.median(x[-max(8,len(x)//10):]));x-=offset;n=len(x);freq=np.fft.rfftfreq(n,1/fs);power=abs(np.fft.rfft(x))**2
 if len(power)<4 or not np.any(power[1:]):raise SignalError('INSUFFICIENT_OBSERVATION','No oscillatory response')
 f0=float(freq[1+np.argmax(power[1:])]);cancel()
 if not 0<f0<fs*.4:raise SignalError('INSUFFICIENT_OBSERVATION','Resolved oscillation below Nyquist required')
 noise=max(float(np.median(abs(np.diff(x[-max(32,n//5):]))))/0.9539,np.finfo(float).eps*max(1.,max(abs(x))))
 peaks,_=signal.find_peaks(x,distance=max(1,int(.65*fs/f0)),prominence=max(noise*2,float(np.max(abs(x)))*.0001))
 peaks=peaks[(x[peaks]>noise*4)&(peaks>1)&(peaks<n-2)]
 if len(peaks)<cfg['minimumPeaks']:raise SignalError('DECAY_PEAKS_INSUFFICIENT','At least six same-phase peaks above noise floor required')
 times=t[peaks];amps=x[peaks]
 # Estimate equilibrium from all decay peaks, not from a possibly nonzero tail.
 initial=stats.linregress(times,np.log(amps));guess=max(1e-8,-initial.slope)
 peak_fit=optimize.least_squares(lambda v:(np.exp(v[0]-v[1]*times)+v[2]-amps)/max(float(np.max(amps)),1e-30),[float(np.log(np.max(amps))+guess*times[0]),guess,0.],bounds=([-1000,0,-np.max(abs(x))],[1000,fs,np.max(abs(x))]),max_nfev=1000)
 equilibrium=float(peak_fit.x[2]);x-=equilibrium;offset+=equilibrium;amps=x[peaks];keep=amps>noise*4;peaks=peaks[keep];times=times[keep];amps=amps[keep]
 if len(peaks)<cfg['minimumPeaks']:raise SignalError('DECAY_PEAKS_INSUFFICIENT','Fewer than six peaks remain above equilibrium/noise')
 periods=np.diff(times)
 if np.std(periods)/np.mean(periods)>cfg['maximumPeriodCV']:raise SignalError('DECAY_PERIOD_INCONSISTENT','Beating or inconsistent peak timing')
 timing=stats.linregress(np.arange(len(peaks)),times);fd=1/timing.slope;fit=stats.linregress(times,np.log(amps));alpha=-float(fit.slope)
 if alpha<=0 or fit.rvalue**2<cfg['minimumEnvelopeR2']:raise SignalError('DECAY_FIT_REJECTED','No reliable positive exponential decay; forced/beating inputs are unsupported')
 wn=math.hypot(alpha,2*np.pi*fd);fn=wn/(2*np.pi);zeta=alpha/wn
 # Check a single damped sinusoid rather than explaining arbitrary envelopes.
 basis=np.column_stack((np.exp(-alpha*t)*np.sin(2*np.pi*fd*t),np.exp(-alpha*t)*np.cos(2*np.pi*fd*t),np.ones(n)))
 coeff=np.linalg.lstsq(basis,x,rcond=None)[0];model=np.einsum('ij,j->i',basis,coeff);residual=float(np.linalg.norm(x-model)/max(np.linalg.norm(x),np.finfo(float).eps))
 if residual>cfg['maximumModelResidualRatio']:raise SignalError('DECAY_MULTIMODE_OR_FORCED','Single-mode decay model cannot explain the actual response')
 alpha_se=float(fit.stderr);fd_se=float(timing.stderr/timing.slope**2)
 return {'modes':[{'status':'identified_partial','naturalFrequencyHz':fn,'dampedFrequencyHz':fd,'dampingRatio':zeta,'decayRatePerSecond':alpha,'timeConstantSeconds':1/alpha,'logDecrementPerCycle':alpha/fd,'shape':None,'shapeReason':'Single response has no measured multi-point phase','uncertainty':{'type':'independent_cycle_regression','alphaStdError':alpha_se,'frequencyStdError':fd_se,'cycles':len(peaks)},'quality':{'envelopeR2':fit.rvalue**2,'periodCV':float(np.std(periods)/np.mean(periods)),'modelResidualRatio':residual}}],
 'evidence':{'time_s':t,'response':x,'fittedResponse':model,'peakTime_s':times,'peakAmplitude':amps,'fittedLogAmplitude':fit.intercept-alpha*times,'logResidual':np.log(amps)-(fit.intercept-alpha*times),'noiseFloor':noise,'equilibriumOffset':offset,'inputChannel':channels[indices[0]]|{'values':None}},'parameters':cfg}

def half_power(t,y,fs,channels,evidence,cancel=lambda:None):
 cfg=METHODS['frf'];forces=[i for i,c in enumerate(channels) if c['role']=='excitation' and c['quantity']=='force'];responses=[i for i,c in enumerate(channels) if c['role']=='response']
 if len(forces)!=1 or len(responses)!=1:raise SignalError('FRF_INPUT_REQUIRED','Exactly one calibrated force and one synchronized response required')
 F=signal.detrend(y[:,forces[0]],type='constant');Y=signal.detrend(y[:,responses[0]],type='constant');n=len(t);count=2**int(np.floor(np.log2(max(16,min(32768,n//8)))))
 f,pff=signal.welch(F,fs,nperseg=count,noverlap=count//2,detrend=False);_,pyy=signal.welch(Y,fs,nperseg=count,noverlap=count//2,detrend=False);_,pyf=signal.csd(F,Y,fs,nperseg=count,noverlap=count//2,detrend=False)
 good=pff>max(float(pff.max())*1e-10,np.finfo(float).tiny);H=np.full(len(f),np.nan+1j*np.nan);H[good]=pyf[good]/pff[good];coh=np.zeros(len(f));den=pff*pyy;np.divide(abs(pyf)**2,den,out=coh,where=den>0);coh=np.clip(coh,0,1)
 mag=abs(H);finite=np.where(good&np.isfinite(mag)&(f>0))[0]
 if len(finite)<10:raise SignalError('FRF_EXCITATION_INSUFFICIENT','Force spectrum has insufficient usable support')
 peaks,_=signal.find_peaks(np.nan_to_num(mag),prominence=float(np.nanmax(mag))*.05)
 if not len(peaks):raise SignalError('FRF_ISOLATED_PEAK_REQUIRED','No isolated force-response resonance')
 k=int(max(peaks,key=lambda i:mag[i]));half=mag[k]**2/2;left=k;right=k
 while left>0 and good[left] and mag[left]**2>half:left-=1
 while right<len(f)-1 and good[right] and mag[right]**2>half:right+=1
 if left==0 or right==len(f)-1 or not all(good[[left,right]]) or mag[left]**2>half or mag[right]**2>half:raise SignalError('FRF_HALF_POWER_CROSSING_MISSING','Both measured half-power crossings are required')
 interpolate=lambda a,b:float(f[a]+(half-mag[a]**2)/(mag[b]**2-mag[a]**2)*(f[b]-f[a]))
 f1=interpolate(left,left+1);f2=interpolate(right-1,right);fr=float(f[k]);df=float(f[1]-f[0]);z_hp=(f2-f1)/(2*fr)
 if f2-f1<cfg['minimumResolvedBandwidthBins']*df:raise SignalError('FRF_RESOLUTION_INSUFFICIENT','Measured peak width needs at least three real frequency bins')
 if not 0<z_hp<cfg['maximumDamping']:raise SignalError('FRF_LIGHT_DAMPING_REQUIRED','Half-power approximation does not meet the light-damping constraint')
 lo=max(1,k-3*(k-left));hi=min(len(f)-1,k+3*(right-k));indices=np.arange(lo,hi+1);indices=indices[good[indices]]
 if any(lo<=other<=hi and other!=k and mag[other]>.3*mag[k] for other in peaks):raise SignalError('FRF_OVERLAPPING_PEAKS','Neighboring resonance prevents a single-mode fit')
 if np.median(coh[left:right+1])<cfg['minimumCoherence']:raise SignalError('FRF_COHERENCE_LOW','Peak coherence below configured minimum')
 quantity=channels[responses[0]]['quantity'];order={'displacement':0,'velocity':1,'acceleration':2}[quantity];w=2*np.pi*f[indices];data=H[indices];scale=float(np.max(abs(data)))
 def model(v):
  wn=2*np.pi*v[0];return complex(v[2],v[3])*(1j*w)**order/(wn**2-w**2+2j*v[1]*wn*w)
 den0=(2*np.pi*fr)**2-w**2+2j*z_hp*(2*np.pi*fr)*w;gain=np.median(data*den0/(1j*w)**order)
 def residual(v):
  z=(model(v)-data)/scale;return np.r_[z.real,z.imag]
 cancel();fit=optimize.least_squares(residual,[fr,z_hp,float(gain.real),float(gain.imag)],bounds=([f[lo],1e-6,-np.inf,-np.inf],[f[hi],cfg['maximumDamping'],np.inf,np.inf]),max_nfev=1000)
 error=float(np.linalg.norm(model(fit.x)-data)/np.linalg.norm(data))
 if not fit.success or error>cfg['maximumRelativeModelResidual']:raise SignalError('FRF_MODEL_FIT_REJECTED','Calibrated local FRF cannot be explained by the selected physical response model')
 covariance=np.linalg.pinv(fit.jac.T@fit.jac)*(np.sum(fit.fun**2)/max(1,len(fit.fun)-len(fit.x)));se=np.sqrt(np.maximum(np.diag(covariance),0))
 return {'modes':[{'status':'identified_partial','naturalFrequencyHz':float(fit.x[0]),'resonanceFrequencyHz':fr,'dampingRatio':float(fit.x[1]),'halfPowerDampingRatio':z_hp,'halfPowerFrequenciesHz':[f1,f2],'shape':None,'shapeReason':'One FRF response is not a complete measured mode shape','uncertainty':{'type':'local_complex_SDOF_fit','frequencyStdError':float(se[0]),'dampingStdError':float(se[1]),'realGridSpacingHz':df},'quality':{'medianPeakCoherence':float(np.median(coh[left:right+1])),'modelRelativeResidual':error,'resolvedBandwidthBins':(f2-f1)/df}}],
 'evidence':{'frequencyHz':f,'frfReal':H.real,'frfImag':H.imag,'frfMagnitude':mag,'coherence':coh,'forcePsd':pff,'responsePsd':pyy,'fitFrequencyHz':f[indices],'fitMagnitude':abs(model(fit.x)),'halfPowerCrossingsHz':[f1,f2],'halfPowerLevel':math.sqrt(half)},'parameters':{**cfg,'welchWindowSamples':count,'overlapSamples':count//2,'crossSpectrumConvention':'E[Y*conj(F)]','responseQuantity':quantity,'model':'complex_SDOF_'+quantity,'interpolation':'linear_between_measured_power_bins'}}

def mac(a,b):
 a=np.asarray(a,dtype=complex);b=np.asarray(b,dtype=complex);den=np.vdot(a,a).real*np.vdot(b,b).real
 return float(abs(np.vdot(a,b))**2/den) if den>0 else 0.
def ssi_cov(t,y,fs,channels,evidence,cancel=lambda:None):
 cfg=METHODS['ssi_cov'];m=len(channels);n=len(t)
 if m<2 or any(c['role']!='response' for c in channels) or len({(c['quantity'],c['unit']) for c in channels})!=1:raise SignalError('SSI_SYNCHRONOUS_RESPONSES_REQUIRED','Compatible synchronous multi-point response channels required')
 if any(not c.get('direction') or c.get('direction')=='unknown' for c in channels):raise SignalError('SSI_DIRECTION_REQUIRED','Mapped physical response directions required')
 if evidence.get('ambientExcitationAssumption') is not True or not evidence.get('excitationAssumptionSource'):raise SignalError('SSI_EXCITATION_ASSUMPTION_REQUIRED','Stationary ambient excitation evidence required')
 if n*m*m>32_000_000:raise SignalError('ANALYSIS_SIZE_UNSUPPORTED','SSI covariance computational budget exceeded')
 x=signal.detrend(y,axis=0,type='constant');energy=np.array([np.mean(a*a,axis=0) for a in np.array_split(x,4)])
 if np.any(np.min(energy,axis=0)<=0) or np.any(np.max(energy,axis=0)/np.min(energy,axis=0)>cfg['stationaryEnergyRatio']):raise SignalError('SSI_NONSTATIONARY_INPUT','Quarter-window response energies violate the stationary-input criterion')
 blocks=min(80,max(12,256//m),n//(2*cfg['minimumSamplesPerCovarianceLag']))
 if blocks<12:raise SignalError('SSI_OBSERVATION_TOO_SHORT','Insufficient real samples for independent covariance lags')
 lags=2*blocks;R=np.empty((lags+1,m,m))
 for a in range(m):
  for b in range(m):
   cancel();c=signal.correlate(x[:,a],x[:,b],mode='full',method='fft');R[:,a,b]=c[n-1:n+lags]/(n-np.arange(lags+1))
 H=np.block([[R[a+b+1] for b in range(blocks)] for a in range(blocks)]);cancel();U,s,_=linalg.svd(H,full_matrices=False,check_finite=False);rank=int(np.sum(s>s[0]*1e-8));maximum=min(30,rank,m*(blocks-1)-1);orders=list(range(2,maximum+1,2))
 if len(orders)<cfg['minimumStableOrders']:raise SignalError('SSI_NUMERICAL_RANK_INSUFFICIENT','Hankel numerical rank cannot support stabilization')
 candidates=[];previous=[];clusters=[]
 for order in orders:
  cancel();O=U[:,:order]*np.sqrt(s[:order]);up=O[:-m];down=O[m:]
  if np.linalg.cond(up)>1e10:continue
  Ad=np.linalg.lstsq(up,down,rcond=None)[0];eigen,vectors=np.linalg.eig(Ad);now=[]
  for j,mu in enumerate(eigen):
   if not np.isfinite(mu) or abs(mu)<=1e-14 or mu.imag<=1e-8:continue
   pole=np.log(complex(mu))*fs;fn=abs(pole)/(2*np.pi);zeta=-pole.real/max(abs(pole),1e-30);shape=O[:m]@vectors[:,j];ref=int(np.argmax(abs(shape)));scale=abs(shape[ref]);phase=np.angle(shape[ref]);shape=shape*np.exp(-1j*phase)/scale if scale else shape
   eligible=0<zeta<cfg['maximumDamping'] and 0<fn<fs/2 and abs(mu)<1
   item={'order':order,'naturalFrequencyHz':float(fn),'dampedFrequencyHz':float(abs(pole.imag)/(2*np.pi)),'dampingRatio':float(zeta),'poleReal':float(pole.real),'poleImag':float(pole.imag),'shapeReal':shape.real.tolist(),'shapeImag':shape.imag.tolist(),'referenceNode':channels[ref]['pointId'],'normalizationPhaseRad':float(phase),'normalizationScale':float(scale),'stable':False,'exclusionReason':None if eligible else 'NONPHYSICAL_OR_UNSTABLE_POLE'}
   if eligible:
    matches=[p for p in previous if abs(fn-p['naturalFrequencyHz'])/fn<cfg['frequencyRelativeTolerance'] and abs(zeta-p['dampingRatio'])/max(zeta,p['dampingRatio'])<cfg['dampingRelativeTolerance'] and mac(shape,np.array(p['shapeReal'])+1j*np.array(p['shapeImag']))>=cfg['minimumMAC']]
    if matches:
     old=min(matches,key=lambda p:abs(p['naturalFrequencyHz']-fn));item['stable']=True;item['matchedOrder']=old['order'];item['MAC']=mac(shape,np.array(old['shapeReal'])+1j*np.array(old['shapeImag']))
     cluster=next((c for c in clusters if old in c),None)
     if cluster is None:cluster=[old];clusters.append(cluster)
     cluster.append(item)
    now.append(item)
   candidates.append(item)
  previous=now
 modes=[]
 for cluster in clusters:
  if len({v['order'] for v in cluster})<cfg['minimumStableOrders']:continue
  selected=cluster[-1]
  if any(abs(selected['naturalFrequencyHz']-v['naturalFrequencyHz'])/selected['naturalFrequencyHz']<cfg['frequencyRelativeTolerance'] for v in modes):continue
  modes.append({**selected,'status':'identified','shape':{'nodes':[{'pointId':c['pointId'],'direction':c.get('direction','unknown'),'real':a,'imag':b} for c,a,b in zip(channels,selected['shapeReal'],selected['shapeImag'])],'referenceNode':selected['referenceNode'],'normalization':'maximum_magnitude_common_reference_phase'},'uncertainty':{'type':'model_order_sensitivity_not_independent_sample_CI','frequencyStd':float(np.std([v['naturalFrequencyHz'] for v in cluster])),'dampingStd':float(np.std([v['dampingRatio'] for v in cluster])),'stableOrders':sorted(set(v['order'] for v in cluster))}})
 if not modes:raise SignalError('SSI_NO_STABLE_MODES','No frequency/damping/MAC cluster met the multi-order requirements')
 return {'modes':sorted(modes,key=lambda v:v['naturalFrequencyHz']),'evidence':{'singularValues':s,'candidatePoles':candidates,'stableClusters':[[{'order':v['order'],'frequencyHz':v['naturalFrequencyHz'],'dampingRatio':v['dampingRatio']} for v in c] for c in clusters]},'parameters':{**cfg,'blockRows':blocks,'modelOrders':orders,'covarianceConvention':'R_j=mean(y[k+j] y[k].T)','hankelConvention':'H[a,b]=R[a+b+1]','actualSamples':n,'sampleIntervalSeconds':1/fs,'numericalRank':rank}}

def compute(data,method,cancel=lambda:None):
 if method not in METHODS:raise SignalError('MODAL_METHOD_UNSUPPORTED','Unknown implemented method')
 t,y,fs,channels,evidence=validate(data)
 result={'decay':decay,'frf':half_power,'ssi_cov':ssi_cov}[method](t,y,fs,channels,evidence,cancel)
 return {**result,'status':'complete' if all(m.get('shape') for m in result['modes']) else 'partially_identified','method':method,'algorithmVersion':VERSION,'sampleRateHz':fs,'observationSeconds':len(t)/fs,'inputSamples':len(t),'sourceKind':data.get('sourceKind','imported_real_dataset'),'healthConclusion':None,'fieldValidation':'not_implied_by_algorithm_execution'}
