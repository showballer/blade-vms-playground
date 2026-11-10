import gzip,json,tempfile,time,unittest,zipfile,hashlib,shutil,os
from unittest.mock import patch
from pathlib import Path
import numpy as np
from blade_acquisition.record_analysis.manager import RecordAnalysisManager
from blade_acquisition.record_analysis.adapter import load_raw,source_fingerprint
from blade_acquisition.record_analysis.outdoor_import import parse,archive_name
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
        # Overview payloads must not duplicate the package manifest for every
        # record; raw provenance, exports and requested detail remain complete.
        overview=self.manager.handle({'action':'result','jobId':report['jobId']})
        self.assertTrue(all('manifestContent' not in r['importSource'] for r in overview['records']))
        self.assertTrue(all(r['importSource']['manifestContentAvailable'] for r in overview['records']))
        self.assertLess(len(json.dumps(overview)),len(json.dumps(report)))
        detail=self.manager.handle({'action':'result','jobId':report['jobId'],'recordingId':task['recordingIds'][0]})
        self.assertIn('manifestContent',detail['detail']['record']['importSource'])
        self.assertIn('manifestContent',self.manager.result({'jobId':report['jobId']})['records'][0]['importSource'])
        catalog=self.manager.handle({'action':'catalog'})
        self.assertTrue(all('manifestContent' not in r['importSource'] for r in catalog['tasks'][0]['records']))
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

    def test_split_import_preserves_synthetic_origin_and_cannot_certify_identity(self):
        for marker in ({'source':'simulation'}, {'source':'measured','simulation':{'dataOrigin':'synthetic','hypothesis':'crack'}}, {'dataOrigin':'synthetic'}):
            with self.subTest(marker=marker):
                (self.source/'1号叶片_0度.csv.gz').write_bytes(sample_file(**marker,identityVerified=True,diagnosticOnly=False,validMeasurement=True))
                imported=self.imported()
                record=next(load_raw(self.manager.recordings,r) for r in imported['recordingIds'] if load_raw(self.manager.recordings,r).manifest['pointCycle']['bladeId']=='1' and load_raw(self.manager.recordings,r).manifest['pointCycle']['azimuthDeg']==0)
                self.assertEqual(record.manifest['source'],'simulation')
                self.assertTrue(record.manifest['simulation'])
                self.assertTrue(record.manifest['diagnosticOnly'])
                self.assertFalse(record.manifest['validMeasurement'])
                self.assertFalse(record.manifest['pointCycle']['identityVerified'])

    def test_declared_context_is_removed_before_waveform_spectrum_and_statistics(self):
        from scipy.signal import detrend,welch
        # A background step must not leak into the blade residual. A real
        # large pulse INSIDE the declared event remains, regardless of RSSI=0.
        blob=sample_file(segmentation={'method':'negative_velocity_excursion_with_local_baseline',
            'boundaryContextSeconds':.12,'eventPeakTimeSeconds':2.5,'boundaryConfirmedByDevice':False})
        lines=gzip.decompress(blob).decode().splitlines()
        for i in range(4000):
            row=lines[i+2].split(',');row[3]=str(2.0 if i<480 or i>=3520 else -.8+.01*np.sin(2*np.pi*40*i/4000)+(1 if i==2000 else 0));lines[i+2]=','.join(row)
        (self.source/'1号叶片_0度.csv.gz').write_bytes(gzip.compress('\n'.join(lines).encode()))
        task=self.imported();before=[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']]
        report=self.run_job(task,{'targetBandMode':'custom','targetBandHz':[0,2000]})
        r=next(r for r in report['records'] if r['object']['blade']=='1' and r['object']['azimuth_deg']==0)
        s=self.manager._load_segment(report['jobId'],r['representative']);raw=load_raw(self.manager.recordings,r['recording_id'])
        self.assertEqual((s.segment.source_start,s.segment.source_end),(480,3520))
        np.testing.assert_allclose(s.analysis_input().values_m_s,detrend(raw.velocity_m_s[480:3520]),atol=1e-12)
        self.assertGreater(s.features['half_peak_to_peak_m_s'],.49)
        self.assertFalse(r['quality_assessment']['health_conclusion_eligible'])
        self.assertEqual([(e['source_start'],e['source_end']) for e in r['quality_events'] if e['code']=='OUTDOOR_BACKGROUND_CONTEXT'],[(0,480),(3520,4000)])
        fs=raw.sample_rate_hz;n=round(report['workspace']['automaticPlan']['sharedWelchSeconds']*fs)
        f,p=welch(s.analysis_input().values_m_s,fs,window='hann',nperseg=n,noverlap=n//2,detrend=False,scaling='density')
        np.testing.assert_allclose(s.spectrum['psd_m2_s2_per_hz'],p,atol=1e-12)
        band=self.manager.extended({'jobId':report['jobId'],'kind':'point_band','resultIds':[r['representative']],'parameters':{'band_hz':[0,2000]}})['points'][0]
        self.assertAlmostEqual(band['mean_azimuth_band_rms_m_s'],np.sqrt(p.sum()*fs/n),12)
        self.assertEqual(before,[source_fingerprint(self.manager.recordings,r) for r in task['recordingIds']])

    def test_inconsistent_context_blocks_instead_of_analysing_background(self):
        (self.source/'1号叶片_0度.csv.gz').write_bytes(sample_file(segmentation={
            'method':'negative_velocity_excursion_with_local_baseline','boundaryContextSeconds':.6}))
        report=self.run_job(self.imported());blocked=[r for r in report['records'] if r.get('status')=='blocked']
        self.assertEqual(len(blocked),1);self.assertIn('OUTDOOR_CONTEXT_INVALID',blocked[0]['issues'])

    def test_zip_filename_without_utf8_flag_and_ignored_duplicate_archives(self):
        info=zipfile.ZipInfo('P2/2号叶片_90度.csv.gz'.encode('utf8').decode('cp437'));info.flag_bits=0
        self.assertEqual(archive_name(info),'P2/2号叶片_90度.csv.gz')
        path=self.root/'mixed.zip'
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('1号叶片_0度.csv.gz',sample_file())
            z.writestr('point.zip',b'not opened, duplicate archive contents')
            z.writestr('__MACOSX/._1号叶片_0度.csv.gz',b'not a data file')
        staged=self.manager.handle({'action':'import_stage','selectedPath':str(path)})
        self.assertEqual(len(staged['files']),1);self.assertFalse(staged['files'][0].get('error'))
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

    def test_multi_point_archives_form_one_task_and_keep_each_blade_point(self):
        archives=[]
        for point in ('P1','P2','P3','P4','P5'):
            path=self.root/(point+'_桌面端导入.zip');archives.append(str(path))
            with zipfile.ZipFile(path,'w') as z:
                z.writestr('manifest.json',json.dumps({'point':point}))
                for blade in ('1','2','3'):
                    for angle in (0,90,180,270):
                        z.writestr(f'{blade}号叶片_{angle}度.csv.gz',sample_file(point=point,windFarm='旧风场',turbine='1303',sourcePointLabel='叶片2 · P4'))
        staged=self.manager.handle({'action':'import_stage','selectedPaths':archives})
        self.assertEqual(len(staged['files']),60)
        self.assertEqual(staged['defaults']['turbine'],'1303')
        self.assertEqual({f['pointName'] for f in staged['files']},{'P1','P2','P3','P4','P5'})
        body={'action':'import_commit','token':staged['token'],'name':'五点同任务','windFarm':'武川风场','turbine':'1号风机',
              'files':[{k:f[k] for k in ('fileId','bladeId','azimuthDeg','pointName','radiusM')} for f in staged['files']]}
        task=self.manager.handle(body)
        self.assertEqual(task['imported'],60)
        self.assertEqual(self.manager.handle(body),task,'Retries must not create a second task')
        tasks=self.manager.catalog()['tasks'];self.assertEqual(len(tasks),1)
        c=tasks[0];self.assertEqual(c['windFarm'],'武川风场');self.assertEqual(c['turbine'],'1号风机')
        self.assertEqual(len(c['plannedPoints']),60)
        self.assertEqual(len({(r['bladeId'],r['pointName'],r['azimuthDeg']) for r in c['records']}),60)
        for rid in task['recordingIds']:
            raw=load_raw(self.manager.recordings,rid);m=raw.manifest;pc=m['pointCycle']
            self.assertIsNone(pc['radiusM']);self.assertEqual(m['point'],pc['radialPointName'])
            self.assertEqual(m['importSource']['originalHeader']['turbine'],'1303')
            self.assertEqual(len(pc['plannedStations']),20)
            self.assertEqual({p['radialPointName'] for p in pc['plannedStations']},{'P1','P2','P3','P4','P5'})
        report=self.run_job(task)
        self.assertEqual(len(report['coverage']['points']),15)
        self.assertEqual(len(report['aggregates']),15)
        self.assertEqual(report['coverage']['analyzableCount'],60)
        for point in report['coverage']['points']:self.assertEqual(point['usableAzimuths'],[0,90,180,270])

    def test_folder_point_fallback_duplicate_and_radius_validation_are_atomic(self):
        root=self.root/'multi';root.mkdir()
        for point in ('P1','P2'):
            directory=root/point;directory.mkdir()
            (directory/'1号叶片_0度.csv.gz').write_bytes(sample_file())
        staged=self.manager.handle({'action':'import_stage','selectedPath':str(root)})
        self.assertEqual({f['pointName'] for f in staged['files']},{'P1','P2'})
        body={'action':'import_commit','token':staged['token'],'name':'两个测点','windFarm':'风场','turbine':'风机',
              'files':[{k:f[k] for k in ('fileId','bladeId','azimuthDeg','pointName')} for f in staged['files']]}
        body['files'][1]['pointName']='P1'
        with self.assertRaisesRegex(ValueError,'角度重复'):self.manager.handle(body)
        self.assertEqual(self.manager.catalog()['tasks'],[])
        body['files'][1]['pointName']='P2';body['files'][1]['radiusM']=-1
        with self.assertRaisesRegex(ValueError,'半径'):self.manager.handle(body)
        self.assertEqual(self.manager.catalog()['tasks'],[])
        body['files'][1]['radiusM']=12
        task=self.manager.handle(body)
        c=self.manager.catalog()['tasks'][0]
        self.assertEqual({r['pointName']:r['radiusM'] for r in c['records']},{'P1':None,'P2':12})
        self.assertEqual(task['imported'],2)

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
