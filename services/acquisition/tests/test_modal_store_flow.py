import json,tempfile,unittest
from pathlib import Path
import numpy as np
from blade_acquisition.record_analysis.modal_store import dispatch
from blade_acquisition.record_analysis.reference.geometry import SignalError

class ModalStoreFlowTests(unittest.TestCase):
 def test_import_preview_compute_and_reload_history(self):
  with tempfile.TemporaryDirectory() as root:
   t=np.arange(2500)/250.;y=.01*np.exp(-.02*2*np.pi*12*t)*np.sin(2*np.pi*12*np.sqrt(1-.02**2)*t+.2)
   data={'schemaVersion':'modal-input-1','sourceKind':'imported_measurement','time_s':t.tolist(),'channels':[{'id':'r1','pointId':'P1','role':'response','quantity':'velocity','unit':'m/s','direction':'axial','calibrationSource':'test fixture calibration','values':y.tolist()}],'evidence':{'excitationRemoved':True,'excitationRemovalSource':'fixture release at start'}}
   saved=dispatch(root,{'operation':'import','parameters':{'name':'flow test fixture','dataset':data}})
   preview=dispatch(root,{'operation':'preview','parameters':{'datasetId':saved['id']}})
   self.assertTrue(preview['displayOnly']);self.assertLessEqual(len(preview['time_s']),2000)
   self.assertEqual(len(preview['time_s']),len(preview['channels'][0]['values']))
   analyzed=dispatch(root,{'operation':'start','parameters':{'datasetId':saved['id'],'method':'decay'}})
   cat=dispatch(root,{'operation':'catalog'});self.assertEqual(cat['jobs'][0]['status'],'complete')
   loaded=dispatch(root,{'operation':'result','parameters':{'jobId':analyzed['job']['id']}})
   self.assertEqual(loaded['result']['modes'][0]['naturalFrequencyHz'],analyzed['result']['modes'][0]['naturalFrequencyHz'])
   self.assertEqual(len(json.loads((Path(root)/'formal-modal-v22/datasets'/(saved['id']+'.json')).read_text())['data']['time_s']),2500)
   # Selecting a method is allowed; incompatible input must still be rejected.
   with self.assertRaises(SignalError):dispatch(root,{'operation':'start','parameters':{'datasetId':saved['id'],'method':'frf'}})
   self.assertTrue(any(j['status']=='failed' for j in dispatch(root,{'operation':'catalog'})['jobs']))
 def test_no_production_import_of_synthetic_preview(self):
  with tempfile.TemporaryDirectory() as root:
   with self.assertRaises(SignalError):dispatch(root,{'operation':'import','parameters':{'dataset':{'schemaVersion':'modal-input-1','synthetic':True}}})
