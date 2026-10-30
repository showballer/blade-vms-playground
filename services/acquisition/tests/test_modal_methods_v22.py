import unittest
import numpy as np
from scipy import signal,linalg
from blade_acquisition.record_analysis.modal_engine import compute,mac,validate
from blade_acquisition.record_analysis.reference.geometry import SignalError

def channel(i,values,quantity='velocity',role='response'):
 return {'id':str(i),'pointId':'p'+str(i),'role':role,'quantity':quantity,'unit':{'velocity':'m/s','displacement':'m','acceleration':'m/s^2','force':'N'}[quantity],'calibrationSource':'known-system test calibration','direction':'axial','values':values.tolist()}
def dataset(t,channels,evidence):return {'schemaVersion':'modal-input-1','sourceKind':'numerical_validation_only','time_s':t.tolist(),'channels':channels,'evidence':evidence}
class ModalMethodTests(unittest.TestCase):
 def test_free_decay_known_parameters(self):
  for fs,fn,zeta in [(250,12.3,.012),(100,3,.03),(1000,25,.02)]:
   t=np.arange(int(fs*5))/fs;wn=2*np.pi*fn;y=.01*np.exp(-zeta*wn*t)*np.sin(wn*np.sqrt(1-zeta*zeta)*t+.2)
   r=compute(dataset(t,[channel(1,y)],{'excitationRemoved':True,'excitationRemovalSource':'known forcing ends at t=0'}),'decay');m=r['modes'][0]
   self.assertLess(abs(m['naturalFrequencyHz']/fn-1),.005);self.assertLess(abs(m['dampingRatio']/zeta-1),.08);self.assertIsNone(m['shape']);self.assertGreaterEqual(len(r['evidence']['peakTime_s']),6)
 def test_no_decay_forcing_and_beating_rejected(self):
  fs=250;t=np.arange(2500)/fs
  for y in [np.sin(2*np.pi*12*t),np.exp(-t)*np.sin(2*np.pi*12*t)+.8*np.exp(-t)*np.sin(2*np.pi*14*t)]:
   with self.assertRaises(SignalError):compute(dataset(t,[channel(1,y)],{'excitationRemoved':True,'excitationRemovalSource':'test challenge'}),'decay')
 def test_decay_requires_explicit_excitation_removal(self):
  t=np.arange(1000)/100;y=np.exp(-t)*np.sin(2*np.pi*3*t)
  with self.assertRaises(SignalError):compute(dataset(t,[channel(1,y)],{}),'decay')
 def test_frf_all_physical_response_quantities(self):
  fs=512;n=131072;t=np.arange(n)/fs;fn=8;zeta=.03;w=2*np.pi*np.fft.rfftfreq(n,1/fs);wn=2*np.pi*fn;F=np.random.default_rng(42).normal(size=n)
  for q,quantity in enumerate(['displacement','velocity','acceleration']):
   H=(1j*w)**q/(wn**2-w**2+2j*zeta*wn*w);Y=np.fft.irfft(np.fft.rfft(F)*H,n=n)
   r=compute(dataset(t,[channel(0,F,'force','excitation'),channel(1,Y,quantity)],{'synchronization':'common_sample_clock','clockSource':'generated exact shared time'}),'frf');m=r['modes'][0]
   self.assertLess(abs(m['naturalFrequencyHz']/fn-1),.01);self.assertLess(abs(m['dampingRatio']/zeta-1),.12);self.assertGreater(m['quality']['medianPeakCoherence'],.9);self.assertEqual(r['parameters']['crossSpectrumConvention'],'E[Y*conj(F)]')
 def test_frf_output_only_is_not_frf(self):
  t=np.arange(4000)/100
  with self.assertRaises(SignalError):compute(dataset(t,[channel(1,np.sin(2*np.pi*3*t))],{}),'frf')
 def test_frf_zero_force_rejected(self):
  t=np.arange(4000)/100
  with self.assertRaises(SignalError):compute(dataset(t,[channel(0,t*0,'force','excitation'),channel(1,np.sin(t))],{'synchronization':'common_sample_clock','clockSource':'test'}),'frf')
 def test_ssi_known_two_mode_three_channel_system(self):
  fs=100;n=30000;freqs=[3.,8.];zetas=[.025,.04];A=linalg.block_diag(*[np.array([[0,1],[-(2*np.pi*f)**2,-2*z*2*np.pi*f]]) for f,z in zip(freqs,zetas)]);B=np.array([[0,0],[(2*np.pi*freqs[0])**2,0],[0,0],[0,(2*np.pi*freqs[1])**2]])
  shapes=np.array([[1,.2],[.6,1],[-.4,.5]]);C=np.column_stack((shapes[:,0],np.zeros(3),shapes[:,1],np.zeros(3)));sys=signal.cont2discrete((A,B,C,np.zeros((3,2))),1/fs);force=np.random.default_rng(77).normal(size=(n,2));_,y,_=signal.dlsim(sys,force);t=np.arange(n)/fs
  data=dataset(t,[channel(i,y[:,i],'displacement') for i in range(3)],{'synchronization':'common_sample_clock','clockSource':'state space output timestamp','ambientExcitationAssumption':True,'excitationAssumptionSource':'independent broadband Gaussian inputs'})
  r=compute(data,'ssi_cov')
  for j,f in enumerate(freqs):
   m=min(r['modes'],key=lambda m:abs(m['naturalFrequencyHz']-f));shape=np.array(m['shapeReal'])+1j*np.array(m['shapeImag']);self.assertLess(abs(m['naturalFrequencyHz']/f-1),.02);self.assertLess(abs(m['dampingRatio']/zetas[j]-1),.5);self.assertGreater(mac(shape,shapes[:,j]),.95);self.assertGreaterEqual(len(m['uncertainty']['stableOrders']),3)
 def test_ssi_does_not_accept_asynchronous_point_list(self):
  t=np.arange(1000)/100
  with self.assertRaises(SignalError):compute(dataset(t,[channel(1,np.sin(t)),channel(2,np.cos(t))],{'ambientExcitationAssumption':True}),'ssi_cov')
 def test_synthetic_preview_and_real_gap_rejected(self):
  t=np.arange(1000)/100;d=dataset(t,[channel(1,np.sin(t))],{});d['containsSynthetic']=True
  with self.assertRaises(SignalError):validate(d)
  d.pop('containsSynthetic');d['time_s'][500]+=.005
  with self.assertRaises(SignalError):validate(d)
 def test_cancellation_checked_before_expensive_steps(self):
  t=np.arange(2000)/100;y=np.exp(-t)*np.sin(2*np.pi*3*t)
  with self.assertRaises(InterruptedError):compute(dataset(t,[channel(1,y)],{'excitationRemoved':True,'excitationRemovalSource':'test'}),'decay',lambda:(_ for _ in ()).throw(InterruptedError('cancelled')))
