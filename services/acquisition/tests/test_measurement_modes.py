import gzip,json,tempfile,time,unittest,zipfile,hashlib,shutil,os
from unittest.mock import patch
from pathlib import Path
import numpy as np
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.adapter import load_raw,source_fingerprint
from blade_acquisition.record_analysis.outdoor_import import parse
from blade_acquisition.record_analysis.packages import create,verify
from blade_acquisition.web_signal import normalized_manifest


def sample_file(angle=0,scale=1,**changes):
    n=4000;fs=4000
    head={'format':'BladeVMS-split-segment-v1','sampleRate':fs,'samples':n,'sourceSampleStart':8000,'sourceSampleEndExclusive':12000,'blade':9,'angleDeg':99,'isCopied':True,'identityVerified':False,'sourceRecordingId':'same-origin',**changes}
    rows=['# BladeVMS '+json.dumps(head),'local_time_s,source_time_s,source_sample_index,velocity_m_s,RSSI_percent,overrange']
    rows.extend(f'{i/fs},{2+i/fs},{8000+i},{scale*.01*np.sin(2*np.pi*40*i/fs)},0,0' for i in range(n))
    return gzip.compress('\n'.join(rows).encode())


class MeasurementModesTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.manager=RecordAnalysisManager(self.root/'app')
        self.source=self.root/'input';self.source.mkdir()
        (self.source/'manifest.json').write_text(json.dumps({'identityVerified':False,'qualityNote':'source evidence retained'}))
        for blade in ('1','2','3'):
            for angle in (0,90,180,270):(self.source/f'{blade}号叶片_{angle}度.csv.gz').write_bytes(sample_file(angle,scale=1 if angle<180 else 3))
    def tearDown(self):self.manager.close();self.temp.cleanup()
    def imported(self):
        s=self.manager.handle({'action':'import_stage','selectedPath':str(self.source)})
        self.assertTrue(all(not f.get('error') for f in s['files']))
        return self.manager.handle({'action':'import_commit','token':s['token'],'name':'户外三叶片','windFarm':'wf1','turbine':'1309','pointName':'P1','files':[{k:f[k] for k in ('fileId','bladeId','azimuthDeg')} for f in s['files']]})
    def run_job(self,task,settings=None):
        j=self.manager.start({'taskId':task['taskId'],'recordingIds':task['recordingIds'],'workspace':{'purpose':'synthesis','algorithmOptions':settings or {}}})
        until=time.monotonic()+20
        while self.manager.status(j['jobId'])['status'] in ('queued','running'):
            self.assertLess(time.monotonic(),until);time.sleep(.01)
        self.assertEqual(self.manager.status(j['jobId'])['status'],'complete')
        return self.manager.result({'jobId':j['jobId']})
    def test_complete_files_distinct_angles_raw_and_no_geometry(self):
        task=self.imported();before=[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']]
        report=self.run_job(task)
        self.assertEqual(report['measurementMode'],'outdoor');self.assertEqual(report['coverage']['analyzableCount'],12)
        self.assertEqual(len(report['aggregates']),3);self.assertEqual(report['captureAliases'],[])
        self.assertEqual(report['coverage']['formalEligibleCount'],0)
        for p in report['coverage']['points']:self.assertEqual(p['usableAzimuths'],[0,90,180,270]);self.assertIsNone(p['radiusM'])
        for r in report['records']:
            segment=r['segments'][0];self.assertEqual((segment['source_start'],segment['source_end']),(0,4000));self.assertEqual(segment['features']['sample_count'],4000)
            self.assertFalse(r['quality_assessment']['health_conclusion_eligible']);self.assertTrue(r['importSource']['originalHeader']['isCopied']);self.assertEqual(r['importSource']['manifestContent']['manifest.json']['qualityNote'],'source evidence retained')
            raw=load_raw(self.manager.recordings,r['recording_id']);self.assertTrue(np.all(raw.rssi_percent==0));self.assertNotEqual(raw.manifest['pointCycle']['bladeId'],'9')
        self.assertEqual(before,[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']])
    def test_band_rms_is_mean_of_angles_and_ar_is_only_display(self):
        r=self.run_job(self.imported(),{'targetBandMode':'custom','targetBandHz':[30,50]})
        records=[v for v in r['records'] if v['object']['blade']=='1'];ids=[v['representative'] for v in records]
        band=self.manager.extended({'jobId':r['jobId'],'kind':'point_band','resultIds':ids,'parameters':{'band_hz':[30,50]}})['points'][0]
        means=[a['mean_band_rms_m_s'] for a in band['azimuth_results']]
        self.assertAlmostEqual(band['mean_azimuth_band_rms_m_s'],np.mean(means),12)
        self.assertNotAlmostEqual(band['mean_azimuth_band_rms_m_s'],np.sqrt(np.mean(np.array(means)**2)),5)
        preview=self.manager.preview({'jobId':r['jobId'],'resultIds':ids,'expectedAzimuths':[0,90,180,270],'automatic':True})
        self.assertFalse(preview['analysis_eligible']);self.assertEqual(len(preview['joins']),3)
        self.assertEqual(len([b for b in preview['blocks'] if b['kind']=='measured_processed']),4)
    def test_portable_package_recomputes_same_results(self):
        task=self.imported();r=self.run_job(task);package=create(self.manager,r['jobId'])
        verified=verify(self.root/'server',Path(package['path']),task['recordingIds'])
        self.assertEqual(verified['report']['coverage']['analyzableCount'],12);self.assertEqual(verified['report']['measurementMode'],'outdoor')
        self.assertEqual(verified['verifiedArrays'],12)

    def test_one_blade_package_does_not_require_other_blades(self):
        task=self.imported();catalog=self.manager.catalog()['tasks'][0]
        task['recordingIds']=[r['id'] for r in catalog['records'] if r['bladeId']=='2']
        r=self.run_job(task);package=create(self.manager,r['jobId'])
        self.assertEqual(set(package['recordingIds']),set(task['recordingIds']))
        verified=verify(self.root/'one-blade-server',Path(package['path']),task['recordingIds'])
        self.assertEqual(verified['verifiedArrays'],4)
    def test_mode_remembered_without_changing_raw_and_indoor_not_forged(self):
        task=self.imported();before=[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']]
        r=self.run_job(task,{'measurementMode':'indoor'});self.assertEqual(r['coverage']['analyzableCount'],0)
        self.assertEqual(self.manager.catalog()['tasks'][0]['measurementMode'],'indoor')
        self.assertEqual(before,[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']])
        r=self.run_job(task,{'measurementMode':'outdoor'});self.assertEqual(r['coverage']['analyzableCount'],12)
    def test_invalid_header_and_zip_traversal_rejected(self):
        bad=self.source/'4号叶片_0度.csv.gz';bad.write_bytes(sample_file(samples=3999))
        s=self.manager.handle({'action':'import_stage','selectedPath':str(self.source)})
        self.assertEqual(len([f for f in s['files'] if f.get('error')]),1)
        path=self.root/'bad.zip'
        with zipfile.ZipFile(path,'w') as z:z.writestr('../bad.csv.gz',sample_file())
        with self.assertRaises(ValueError):self.manager.handle({'action':'import_stage','selectedPath':str(path)})
    def test_web_normalization_preserves_mapping_and_source_clock(self):
        m={'sourceMetadata':{'measurementMode':'outdoor','outdoorSegment':{'sourceClock':{'sourceSampleStart':8000}},'importSource':{'originalHeader':{'blade':9}},'pointCycle':{'bladeId':'1','azimuthDeg':270}}}
        n=normalized_manifest(m,'a'*32,4000,4000)
        self.assertEqual(n['measurementMode'],'outdoor');self.assertEqual(n['pointCycle']['azimuthDeg'],270);self.assertEqual(n['importSource']['originalHeader']['blade'],9)
        self.assertNotIn('handoff',n['pointCycle'])

    def test_absolute_source_clock_adds_sample_offset_once(self):
        (self.source/'1号叶片_0度.csv.gz').write_bytes(sample_file(sourceSampleOrigin=1800000000))
        task=self.imported()
        records=[load_raw(self.manager.recordings,r) for r in task['recordingIds']]
        timed=[r for r in records if r.manifest['sampleOrigin']]
        self.assertEqual(len(timed),1)
        self.assertEqual(timed[0].manifest['sampleOrigin'],1800000002)
        self.assertTrue(all(r.manifest['startedAt'] is None for r in records if not r.manifest['sampleOrigin']))

    def test_native_cloud_upload_validates_and_retains_full_precision_source(self):
        from blade_acquisition.native_capture import validate_capture, import_capture
        from blade_acquisition.storage import RecordingStore
        task=self.imported();rid=task['recordingIds'][0]
        root=self.root/'cloud-captures';directory=root/rid/'complete'
        shutil.copytree(self.manager.recordings/rid,directory)
        files=[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in directory.iterdir() if p.name!='manifest.json']
        (directory/'transfer.json').write_text(json.dumps({'files':files}))
        with patch.dict(os.environ,{'BLADE_CAPTURE_DATA_DIR':str(root)}):
            self.assertEqual(validate_capture(directory)['id'],rid)
            store=RecordingStore(self.root/'analysis-copies')
            imported=import_capture(store,directory)['recording']
            raw=load_raw(store.root,imported['id'])
            np.testing.assert_array_equal(raw.velocity_m_s,load_raw(self.manager.recordings,rid).velocity_m_s)
            self.assertTrue((store.root/imported['id']/'split-source.csv.gz').exists())
            self.assertEqual(raw.manifest['measurementMode'],'outdoor')
            self.assertTrue(raw.manifest['pointCycle']['radialPointId'])
            # A self-consistent transfer hash must not permit changing only CSV.
            changed=sample_file(scale=9);(directory/'split-source.csv.gz').write_bytes(changed)
            item=next(f for f in files if f['name']=='split-source.csv.gz');item.update(bytes=len(changed),sha256=hashlib.sha256(changed).hexdigest())
            (directory/'transfer.json').write_text(json.dumps({'files':files}))
            with self.assertRaisesRegex(ValueError,'不一致'):validate_capture(directory)

if __name__=='__main__':unittest.main()
