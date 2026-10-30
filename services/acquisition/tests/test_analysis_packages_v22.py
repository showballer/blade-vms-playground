import tempfile,unittest,time,json,zipfile,hashlib
from pathlib import Path
from test_record_analysis_manager import write_record
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.packages import create,verify,unpack
from blade_acquisition.record_analysis.reference.geometry import SignalError
class PackageTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);(self.root/'recordings').mkdir();self.rid=write_record(self.root/'recordings',n=8000,fs=4000.);self.manager=RecordAnalysisManager(self.root);task=self.manager.catalog()['tasks'][0];job=self.manager.start({'taskId':task['id'],'recordingIds':[self.rid],'workspace':{'purpose':'synthesis','algorithmOptions':{}}});self.job=job['jobId']
  until=time.monotonic()+10
  while self.manager.status(self.job)['status'] in ('queued','running'):
   self.assertLess(time.monotonic(),until);time.sleep(.01)
  self.assertEqual(self.manager.status(self.job)['status'],'complete');self.package=create(self.manager,self.job)
 def tearDown(self):self.manager.close();self.temp.cleanup()
 def test_full_array_roundtrip_and_idempotency(self):
  remote=self.root/'remote';v=verify(remote,Path(self.package['path']),[self.rid]);self.assertEqual(v['report']['processingSource'],'desktop_verified');self.assertEqual(v['verifiedArrays'],1);self.assertEqual(v,verify(remote,Path(self.package['path']),[self.rid]));self.assertEqual(v['report']['records'][0]['source_hash'],self.manager.result({'jobId':self.job})['records'][0]['source_hash'])
 def test_missing_dependencies_and_cross_account_scope(self):
  self.assertRaises(SignalError,verify,self.root/'foreign',Path(self.package['path']),[])
 def test_server_known_source_is_checked_not_only_client_checksums(self):
  import shutil
  remote=self.root/'server';shutil.copytree(self.root/'recordings',remote/'recordings')
  good=verify(remote,Path(self.package['path']),[self.rid],{self.rid:self.rid});self.assertEqual(good['sourceRelations'][0]['relation'],'exact_native_or_recomputed_antialias_derivative')
  p=remote/'recordings'/self.rid/'chunk-00000000.bin';b=bytearray(p.read_bytes());b[-3]^=1;p.write_bytes(b)
  with self.assertRaises(SignalError):verify(remote,Path(self.package['path']),[self.rid],{self.rid:self.rid})
 def test_native_dependency_matches_authorized_downsample_and_metadata(self):
  import shutil
  from blade_acquisition.upload_sampling import prepare_upload
  from blade_acquisition.record_analysis.packages import validate_server_sources
  base=self.root/'package-input';(base/'recordings').mkdir(parents=True);rid=write_record(base/'recordings',n=8000,fs=50000.)
  class Store:
   def directory(self,r):return base/'recordings'/r
   def _read_manifest(self,d):return json.loads((d/'manifest.json').read_text())
   def chunks(self,d):return sorted(d.glob('chunk-*.bin'))
  output=prepare_upload(Store(),rid,10000,self.root/'pre-existing-50k-copy');remote=self.root/'downsample-server';shutil.copytree(output['directory'],remote/'recordings'/rid)
  self.assertEqual(validate_server_sources(remote,base,{rid:rid})[0]['nativeId'],rid)
  p=remote/'recordings'/rid/'manifest.json';m=json.loads(p.read_text());m['pointCycle']['handoff']['exitSampleIndex']+=1;p.write_text(json.dumps(m))
  self.assertRaises(SignalError,validate_server_sources,remote,base,{rid:rid})
 def rewritten(self,change):
  target=self.root/'tampered.zip'
  with zipfile.ZipFile(self.package['path']) as z:files={n:z.read(n) for n in z.namelist()}
  change(files)
  with zipfile.ZipFile(target,'w') as z:
   for n,b in files.items():z.writestr(n,b)
  return target
 def test_byte_tamper_rejected(self):
  p=self.rewritten(lambda f:f.__setitem__(next(n for n in f if n.endswith('.bin')),b'bad'))
  self.assertRaises(SignalError,verify,self.root/'bad',p,[self.rid])
 def test_checksum_valid_forged_scalar_recomputed_rejected(self):
  def change(f):
   name='analysis/result.json';r=json.loads(f[name]);r['aggregates'][0]['mean_half_peak_to_peak_m_s']=999.;f[name]=json.dumps(r).encode();m=json.loads(f['package.json']);m['files'][name]={'bytes':len(f[name]),'sha256':hashlib.sha256(f[name]).hexdigest()};f['package.json']=json.dumps(m).encode()
  p=self.rewritten(change);self.assertRaises(SignalError,verify,self.root/'false',p,[self.rid])
 def test_traversal_and_unknown_plan_rejected(self):
  p=self.rewritten(lambda f:f.__setitem__('../escape',b'bad'));self.assertRaises(SignalError,verify,self.root/'traversal',p,[self.rid])
  def change(f):
   m=json.loads(f['package.json']);m['contract']['version']='other';f['package.json']=json.dumps(m).encode()
  p=self.rewritten(change);self.assertRaises(SignalError,verify,self.root/'legacy',p,[self.rid])
