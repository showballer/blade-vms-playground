"""Derive time-aligned scenario records; preserve all waveform payload bytes."""
import copy, gzip, hashlib, json, pathlib, struct, sys
from datetime import datetime

plan = json.loads(pathlib.Path(sys.argv[1]).read_text())
root, out = pathlib.Path(plan['recordings']), pathlib.Path(plan['output'])
out.mkdir(parents=True, exist_ok=True)
header_struct = struct.Struct('<8sddQ')
items=[]
for rid in plan['originalRecordingIds']:
    src=root/rid
    original=json.loads((src/'manifest.json').read_text())
    assert original['source']=='simulation' and original['simulation']['dataOrigin']=='synthetic'
    new_id=hashlib.sha256(('huade-020-20261018-v1:'+rid).encode()).hexdigest()[:32]
    m=copy.deepcopy(original)
    old_epoch=m['sampleOrigin']
    # Fixed date shift, preserving original intra-batch timing and spacing.
    # Explicit Beijing clock, independent of process timezone.
    from datetime import timezone, timedelta
    tz=timezone(timedelta(hours=8))
    clock=datetime.fromtimestamp(old_epoch,tz)
    origin=clock.replace(year=2026,month=10,day=18).timestamp()
    delta=origin-old_epoch
    sim=m['simulation']
    sim.update(originalScenarioTurbine=sim.get('originalScenarioTurbine',sim['scenarioTurbine']),scenarioTurbine='020#',timeAlignment={'originalEpoch':old_epoch,'alignedEpoch':origin,'deltaSeconds':delta,'sourceWindSha256':plan['sourceWindSha256'],'basis':'用户指定：仅平移合成数据日期，与2026-10-18化德020#实测分钟工况作情景关联；不代表同期实测'})
    m.update(id=new_id,name=plan['name'],turbine='020#',windFarm=plan['farmCode'],originalScenarioRecordingId=rid,sampleOrigin=origin,startedAt=origin,endedAt=original['endedAt']+delta)
    m['pointCycle']['collectionId']='huade-020-scenario-20261018'
    m['outdoorSegment']['sourceClock']['sourceEpoch']+=delta
    filename=f"化德风场_B071-20_020#_20261018_{m['point']}_叶片{m['pointCycle']['bladeId']}_{m['pointCycle']['azimuthDeg']:03g}度_合成.csv.gz"
    blob=(src/'split-source.csv.gz').read_bytes()
    first, body=gzip.decompress(blob).split(b'\n',1)
    h=json.loads(first.decode().removeprefix('# BladeVMS '))
    h.update(name=plan['name'],windFarm=plan['farmCode'],turbine='020#',simulation=copy.deepcopy(sim),pointCycle=copy.deepcopy(m['pointCycle']))
    h['sourceSampleOrigin']+=delta
    csv=gzip.compress(('# BladeVMS '+json.dumps(h,ensure_ascii=False,separators=(',',':'))+'\n').encode()+body,mtime=0)
    m['importSource'].update(originalHeader=h,fileName=filename,sha256=hashlib.sha256(csv).hexdigest(),derivedFrom={'recordingId':rid,'originalFileSha256':original['importSource']['sha256'],'waveformCsvBodySha256':hashlib.sha256(body).hexdigest()})
    native=(src/'chunk-00000000.bin').read_bytes()
    magic,fs,previous,start=header_struct.unpack(native[:header_struct.size])
    assert previous==old_epoch
    aligned=header_struct.pack(magic,fs,origin,start)+native[header_struct.size:]
    assert aligned[header_struct.size:]==native[header_struct.size:]
    dst=root/new_id
    expected={'manifest.json':json.dumps(m,ensure_ascii=False,separators=(',',':')).encode(),'split-source.csv.gz':csv,'chunk-00000000.bin':aligned}
    if dst.exists():
        for name,data in expected.items():assert (dst/name).read_bytes()==data, 'Conflicting existing derivative'
    else:
        dst.mkdir()
        for name,data in expected.items():(dst/name).write_bytes(data)
    export=out/'分段数据'/m['point']/filename
    export.parent.mkdir(parents=True,exist_ok=True);export.write_bytes(csv)
    items.append({'originalRecordingId':rid,'recordingId':new_id,'blade':m['pointCycle']['bladeId'],'point':m['point'],'angle':m['pointCycle']['azimuthDeg'],'radiusM':m['pointCycle']['radiusM'],'originalEpoch':old_epoch,'alignedEpoch':origin,'deltaSeconds':delta,'file':str(export.relative_to(out)),'sha256':hashlib.sha256(csv).hexdigest(),'waveformPayloadUnchanged':True})
receipt={'dataOrigin':'synthetic','name':plan['name'],'turbineCode':'020#','sourceWindSha256':plan['sourceWindSha256'],'records':items}
(out/'时间对齐与来源.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
print(json.dumps({'records':len(items),'start':min(x['alignedEpoch'] for x in items),'end':max(x['alignedEpoch'] for x in items),'waveformPayloadUnchanged':True}))
