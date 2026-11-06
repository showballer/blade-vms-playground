import copy,json,tempfile,time,unittest,threading
from pathlib import Path
from unittest.mock import patch
import numpy as np
from blade_acquisition.modal_capture import ModalCaptureController,validate_plan
from blade_acquisition.record_analysis.modal_store import dispatch


def plan(method='frf'):
 channels=[{'id':'ch'+str(i),'hardwareChannel':'AI'+str(i),'pointId':'force' if method=='frf' and i==0 else 'P'+str(i),'quantity':'force' if method=='frf' and i==0 else 'velocity','direction':'flapwise','calibrationSource':'test fixture coefficients','scaleToSI':.001 if i else 1} for i in range(2 if method=='frf' else 3)]
 return {'method':method,'name':'isolated capture fixture','deviceId':'fixture-device','boundary':'fixed blade test fixture','excitation':'known fixture input','sampleRateHz':128.,'durationSeconds':1.,'conditionsConfirmed':True,'channels':channels,'context':{'turbine':'fixture'}}

def ready_info(p):return {'sampleRateHz':p['sampleRateHz'],'synchronization':'common_sample_clock','clockSource':'fixture shared hardware clock','channelIds':[c['id'] for c in p['channels']]}

class Receiver:
 def run(self,p,ready,samples,stop):
  ready(ready_info(p))
  for start in range(0,p['targetSamples'],32):
   if stop.is_set():break
   t=np.arange(start,start+32)/p['sampleRateHz'];samples(start,np.column_stack([np.cos(2*np.pi*12*t)*(i+1) for i in range(len(p['channels']))]))

class ModalCaptureTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.controllers=[]
 def tearDown(self):
  for c in self.controllers:c.close()
  self.temp.cleanup()
 def controller(self,receiver=Receiver,**kwargs):
  c=ModalCaptureController(self.root,receiver,**kwargs);self.controllers.append(c);return c
 def finished(self,c):
  limit=time.monotonic()+3
  while c.active():
   if time.monotonic()>limit:self.fail('capture did not finish')
   time.sleep(.005)
  return c.status()
 def test_both_methods_capture_synchronous_raw_and_save_selectable_batch(self):
  for method in ('frf','ssi_cov'):
   c=self.controller();c.start(plan(method));status=self.finished(c)
   self.assertEqual(status['state'],'complete',status);saved=status['dataset'];self.assertEqual(saved['samples'],128)
   path=self.root/'formal-modal-v22/datasets'/(saved['id']+'.json');data=json.loads(path.read_text(encoding="utf-8"))['data']
   self.assertEqual(data['evidence']['synchronization'],'common_sample_clock');self.assertEqual(len(data['channels']),2 if method=='frf' else 3)
   self.assertAlmostEqual(data['channels'][1]['values'][0],.002)
   self.assertEqual(len(data['sourceReference']['rawSha256']),64)
   self.assertIn(saved['id'],[d['id'] for d in dispatch(self.root,{'operation':'catalog'})['datasets']])
   self.assertTrue((self.root/'modal-captures'/status['id']/'received.jsonl').is_file())
 def test_missing_driver_and_invalid_plan_do_not_create_batches(self):
  with patch.dict('os.environ',{'BLADE_MODAL_DRIVER':''}):c=self.controller(None)
  with self.assertRaisesRegex(ValueError,'驱动'):c.start(plan())
  self.assertEqual(list((self.root/'modal-captures').iterdir()),[])
  for change in ({'durationSeconds':float('nan')},{'durationSeconds':7200,'sampleRateHz':20000},{'conditionsConfirmed':False}):
   with self.assertRaises(ValueError):validate_plan({**plan(),**change})
  p=plan('ssi_cov');p['channels'][1]['hardwareChannel']='AI0'
  with self.assertRaises(ValueError):validate_plan(p)
 def test_clock_gap_never_becomes_completed_dataset(self):
  class Broken:
   def run(self,p,ready,samples,stop):
    ready(ready_info(p));samples(0,np.ones((32,2)));samples(33,np.ones((32,2)))
  c=self.controller(Broken);c.start(plan());s=self.finished(c)
  self.assertEqual(s['state'],'error');self.assertIn('样本序号',s['error']);self.assertIsNone(s['dataset']);self.assertEqual(dispatch(self.root,{'operation':'catalog'})['datasets'],[])
 def test_clock_rate_mismatch_refused_before_samples(self):
  class Broken:
   def run(self,p,ready,samples,stop):ready({**ready_info(p),'sampleRateHz':100.})
  c=self.controller(Broken);c.start(plan());s=self.finished(c);self.assertEqual(s['state'],'error');self.assertEqual(s['samples'],0)
 def test_stop_saves_received_samples_and_rejects_stale_session(self):
  arrived=threading.Event()
  class Waiting:
   def run(self,p,ready,samples,stop):
    ready(ready_info(p));samples(0,np.ones((64,2)));arrived.set();stop.wait(2)
  c=self.controller(Waiting);s=c.start({**plan(),'durationSeconds':10.});self.assertTrue(arrived.wait(1))
  with self.assertRaises(BlockingIOError):c.start(plan())
  with self.assertRaises(ValueError):c.stop('a'*32)
  c.stop(s['id']);saved=self.finished(c);self.assertEqual(saved['state'],'complete');self.assertTrue(saved['dataset']['sourceReference']['stoppedEarly']);self.assertEqual(saved['samples'],64)
 def test_native_capture_exclusion_and_interruption_recovery(self):
  c=self.controller(device_busy=lambda:True)
  with self.assertRaises(BlockingIOError):c.start(plan())
  folder=self.root/'modal-captures'/('a'*32);folder.mkdir();(folder/'session.json').write_text(json.dumps({'state':'acquiring'}));c2=self.controller()
  self.assertEqual(json.loads((folder/'session.json').read_text(encoding="utf-8"))['state'],'error')
 def test_http_start_stop_and_native_capture_exclusion(self):
  from fastapi.testclient import TestClient
  from blade_acquisition.service import Settings,create_app
  arrived=threading.Event()
  class Waiting:
   def run(self,p,ready,samples,stop):ready(ready_info(p));samples(0,np.ones((64,2)));arrived.set();stop.wait(2)
  settings=Settings('x'*40,8765,self.root)
  app=create_app(settings,modal_receiver_factory=Waiting)
  with TestClient(app,base_url='http://127.0.0.1:8765',headers={'Authorization':'Bearer '+settings.token}) as client:
   start=client.post('/api/field/formal-modal',json={'operation':'capture-start','parameters':plan()});self.assertEqual(start.status_code,200,start.text);self.assertTrue(arrived.wait(1));sid=start.json()['id']
   native=client.post('/api/field/start',json={'name':'blocked fixture','deviceIp':'192.168.1.2','hostIp':'192.168.1.3','confirmLaser':True})
   self.assertEqual(native.status_code,409)
   response=client.post('/api/field/formal-modal',json={'operation':'capture-stop','parameters':{'sessionId':sid}});self.assertEqual(response.status_code,200)
   self.assertEqual(self.finished(app.state.modal_capture)['state'],'complete')
