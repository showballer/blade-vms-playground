from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import numpy as np
from blade_acquisition.storage import HEADER, MAGIC, RECORD_DTYPE, RecordingStore

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'import-blade-task-zips.py'
spec = importlib.util.spec_from_file_location('task_zip_import', SCRIPT)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class TaskZipImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def package(self, point=1, *, blade='2', bad_time=False, mismatch=False, traversal=False,
                task_mismatch=False, stride=1, invalid_flag=False):
        rid = f'{point:032x}'
        cycle = {'mode':'automatic_stations', 'executionMode':'manual_segments',
            'collectionId':f'{point+100:032x}', 'bladeId':blade,
            'radialPointId':f'radial-{point}', 'radialPointName':f'P{point}',
            'radiusM':point*.1, 'sessionId':f'{point+200:032x}',
            'stationId':f'p{point}-s1', 'stationIndex':1, 'stationCount':4,
            'lapIndex':1, 'azimuthDeg':0, 'completion':'diagnostic_pass', 'outcome':'diagnostic',
            'passCompleteness':'confirmed', 'continuousSession':{'sampleStart':100},
            'handoff':{'sampleClock':'continuous_session_raw','entrySampleIndex':90,
                       'entryConfirmedSampleIndex':99,'exitSampleIndex':103,'exitConfirmedSampleIndex':104}}
        manifest = {'id':rid, 'name':f'original-p{point}', 'originalTaskName':f'original-p{point}',
            'windFarm':'wf1','turbine':'1303','object':'', 'point':f'P{point} · 0°',
            'source':'polytec_ivs500', 'unit':'m/s','status':'complete','error':None,
            'captureSessionId':f'external-capture-{point}',
            'samples':4, 'sampleRate':250000., 'sampleOrigin':1700000000.,
            'startedAt':1700000000.,'endedAt':1700000001.,'pointCycle':cycle,
            'diagnosticOnly':True,'validMeasurement':False,'dataLossAssessment':'unverified',
            'overrangeSamples':1,'missingRssiSamples':2 if stride==2 else 0,
            'rssiSampleStride':stride,'rssiSampleRate':250000/stride,
            'format':'BLADEV01/<QidifB', 'chunks':1}
        entry = {'recordingId':rid,'name':manifest['name'],'windFarm':'wf1','turbine':'1303','object':'',
            'bladeId':blade,'point':f'P{point}','radialPointId':cycle['radialPointId'],'radiusM':cycle['radiusM'],
            'executionMode':'manual_segments','sessionId':cycle['sessionId'],'station':1,'lap':1,
            'azimuthDeg':0,'completion':'diagnostic_pass','stationCount':4,'status':'complete','error':None,
            'samples':4,'sampleRate':250000.,'startedAt':manifest['startedAt'],'endedAt':manifest['endedAt'],
            'dataState':'csv','manifest':'data/manifest.json','waveform':'data/waveform.csv'}
        if task_mismatch: entry['samples']=5
        task={'format':'blade-vms-task-export-1','recordCount':1,'records':[entry]}
        csvmeta={k:copy.deepcopy(manifest[k]) for k in ('name','source','samples','sampleRate','unit','windFarm','turbine','object','point','pointCycle','sampleOrigin','rssiSampleStride','rssiSampleRate')}
        csvmeta.update(format='blade-vms-csv-1',recordingId=rid)
        if mismatch: csvmeta['pointCycle']['radiusM']=999
        rows=[]
        for i,v in enumerate([.123456789012345,-.98765432109876,0.,.25]):
            t=(i+1 if bad_time and i==2 else i)/250000
            rssi='' if i%stride else str(20+i)
            flag='2' if invalid_flag and i==1 else str(int(i==2))
            rows.append(f'{t:.17g},{v:.17g},{rssi},{flag}\n')
        csv='# BladeVMS '+json.dumps(csvmeta)+'\n'+'time_s,velocity_m_s,RSSI_percent,overrange\n'+''.join(rows)
        path=self.root/f'p{point}.zip'
        with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('task.json',json.dumps(task));z.writestr('data/manifest.json',json.dumps(manifest))
            z.writestr('data/waveform.csv',csv)
            if traversal:z.writestr('../escape','bad')
        return path, manifest

    def test_merges_logical_task_preserving_samples_diagnostic_boundary_and_session(self):
        paths, originals=zip(*(self.package(1),self.package(2)))
        before=[p.read_bytes() for p in paths]
        receipt=importer.import_packages(paths,self.root/'out','合并任务')
        self.assertEqual(receipt['recordCount'],2);self.assertEqual(receipt['samples'],8)
        store=RecordingStore(self.root/'out')
        for original, rid in zip(originals,receipt['recordingIds']):
            m=store._read_manifest(store.directory(rid));p=m['pointCycle']
            self.assertNotEqual(rid,original['id'])
            self.assertEqual(m['name'],'合并任务');self.assertEqual(m['originalTaskName'],'合并任务')
            self.assertEqual(p['collectionId'],receipt['collectionId'])
            self.assertEqual(p['sessionId'],original['pointCycle']['sessionId'])
            self.assertEqual(p['handoff'],original['pointCycle']['handoff'])
            self.assertTrue(m['diagnosticOnly']);self.assertFalse(m['validMeasurement'])
            self.assertEqual(m['source'],'polytec_ivs500');self.assertFalse(m['importSource']['autoUpload'])
            self.assertNotIn('captureSessionId',m)
            self.assertEqual(m['importSource']['originalCaptureSessionId'],original['captureSessionId'])
            self.assertFalse(m['importSource']['rawCodesAvailable']);self.assertFalse(m['mergedTask']['continuousMeasurement'])
            self.assertEqual(json.loads((store.directory(rid)/'source-export-manifest.json').read_text()),original)
            chunk=store.chunks(store.directory(rid))[0].read_bytes()
            self.assertEqual(HEADER.unpack(chunk[:HEADER.size]),(MAGIC,250000.,1700000000.,0))
            data=np.frombuffer(chunk[HEADER.size:],dtype=RECORD_DTYPE)
            np.testing.assert_array_equal(data['velocity'],[.123456789012345,-.98765432109876,0.,.25])
            np.testing.assert_array_equal(data['flags'],[2,2,3,2])
        self.assertEqual([p.read_bytes() for p in paths],before)

    def test_repeated_import_and_duplicate_archive_are_idempotent(self):
        path,_=self.package(); duplicate=self.root/'duplicate.zip';duplicate.write_bytes(path.read_bytes())
        first=importer.import_packages([path,duplicate],self.root/'out','合并')
        second=importer.import_packages([path],self.root/'out','合并')
        self.assertEqual(first['recordCount'],1);self.assertTrue(second['reused'])
        self.assertEqual(first['recordingIds'],second['recordingIds'])

    def test_existing_live_store_is_never_modified(self):
        path,_=self.package();out=self.root/'out';out.mkdir();(out/'keep').write_text('keep')
        with self.assertRaisesRegex(ValueError,'不是本工具'): importer.import_packages([path],out,'合并')
        self.assertEqual(list(out.iterdir()),[out/'keep'])

    def test_same_output_rejects_tampered_binary(self):
        path,_=self.package();result=importer.import_packages([path],self.root/'out','合并')
        chunk=self.root/'out'/result['recordingIds'][0]/'chunk-00000000.bin'
        chunk.write_bytes(chunk.read_bytes()+b'bad')
        with self.assertRaisesRegex(ValueError,'内容已变化'):importer.import_packages([path],self.root/'out','合并')

    def test_sparse_rssi_slots_remain_sparse(self):
        path,_=self.package(stride=2);result=importer.import_packages([path],self.root/'out','合并')
        chunk=(self.root/'out'/result['recordingIds'][0]/'chunk-00000000.bin').read_bytes()
        data=np.frombuffer(chunk[HEADER.size:],dtype=RECORD_DTYPE)
        np.testing.assert_array_equal(data['flags'],[2,0,3,0])

    def test_rejects_cross_blade_packages(self):
        a,_=self.package(1);b,_=self.package(2,blade='3')
        with self.assertRaisesRegex(ValueError,'同一风场'):importer.import_packages([a,b],self.root/'out','合并')
        self.assertFalse((self.root/'out').exists())

    def test_rejects_traversal(self):
        p,_=self.package(traversal=True)
        with self.assertRaisesRegex(ValueError,'不安全'):importer.import_packages([p],self.root/'out','合并')

    def test_rejects_metadata_mismatch_without_partial_output(self):
        a,_=self.package(1);b,_=self.package(2,mismatch=True)
        with self.assertRaisesRegex(ValueError,'pointCycle'):importer.import_packages([a,b],self.root/'out','合并')
        self.assertFalse((self.root/'out').exists())
        self.assertFalse(list(self.root.glob('.blade-task-import-*')))

    def test_rejects_task_manifest_mismatch(self):
        p,_=self.package(task_mismatch=True)
        with self.assertRaisesRegex(ValueError,'任务清单'):importer.import_packages([p],self.root/'out','合并')

    def test_rejects_sample_time_gap(self):
        p,_=self.package(bad_time=True)
        with self.assertRaisesRegex(ValueError,'时间轴不连续'):importer.import_packages([p],self.root/'out','合并')

    def test_rejects_invalid_overrange(self):
        p,_=self.package(invalid_flag=True)
        with self.assertRaisesRegex(ValueError,'质量标记'):importer.import_packages([p],self.root/'out','合并')


if __name__=='__main__':unittest.main()
