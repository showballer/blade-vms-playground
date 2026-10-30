from pathlib import Path
import tempfile
import time
import unittest
from fastapi.testclient import TestClient
from blade_acquisition.service import Settings,create_app
from test_record_analysis_manager import write_record

class RecordAnalysisApiTests(unittest.TestCase):
    def test_authenticated_local_api_uses_saved_files_and_does_not_start_hardware(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);raw=root/'recordings';raw.mkdir();rid=write_record(raw)
            def forbidden(*a,**k):raise AssertionError('analysis must never construct device/controller hardware')
            token='independent-analysis-unit-test-token-32characters'
            app=create_app(Settings(token,8765,root),forbidden,forbidden)
            with TestClient(app,base_url='http://127.0.0.1:8765',headers={'Authorization':'Bearer '+token}) as client:
                self.assertEqual(client.post('/api/field/record-analysis',json={'action':'catalog'},headers={'Authorization':''}).status_code,401)
                catalog=client.post('/api/field/record-analysis',json={'action':'catalog'}).json()
                task=catalog['tasks'][0]
                start=client.post('/api/field/record-analysis',json={'action':'start','taskId':task['id'],'recordingIds':[rid]})
                self.assertEqual(start.status_code,200,start.text);job=start.json()['jobId']
                deadline=time.monotonic()+10
                while time.monotonic()<deadline:
                    state=client.post('/api/field/record-analysis',json={'action':'status','jobId':job}).json()
                    if state['status'] not in ('queued','running'):break
                    time.sleep(.02)
                self.assertEqual(state['status'],'complete',state)
                detail=client.post('/api/field/record-analysis',json={'action':'result','jobId':job,'recordingId':rid})
                self.assertEqual(detail.status_code,200,detail.text)
                self.assertEqual(detail.json()['coverage']['analyzableCount'],1)
                self.assertLess(len(detail.content),8*1024*1024)
                state=client.get('/api/field/status').json();self.assertEqual(state['state'],'idle')
                self.assertFalse(state['receiver']['running'])
                bad=client.post('/api/field/record-analysis',json={'action':'extended','jobId':job,'resultId':'synthetic-preview','kind':'stft'})
                self.assertEqual(bad.status_code,422)
                export=client.post('/api/field/record-analysis',json={'action':'export','jobId':job,'kind':'analysis'})
                self.assertEqual(export.status_code,200,export.text)
                self.assertTrue(Path(export.json()['path']).is_file())
                escape=client.post('/api/field/record-analysis',json={'action':'export','jobId':job,'kind':'analysis','path':'/tmp/escape'})
                self.assertEqual(escape.status_code,422)

if __name__=='__main__':unittest.main()
