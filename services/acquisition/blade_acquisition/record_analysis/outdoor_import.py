"""Bounded, staged import of vendor-independent BladeVMS split segments.

No hardware access. Original packages remain in the import archive. Each file
gets an independent local ID; old capture IDs/labels are provenance only.
"""
import csv
import gzip
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import time
import uuid
import zipfile
import numpy as np
from ..storage import HEADER, MAGIC, RECORD_DTYPE, atomic_json
from .adapter import ID, task_key
from .reference.geometry import SignalError

FORMAT = 'BladeVMS-split-segment-v1'
LIMIT = 256*1024*1024
COLUMNS = ('local_time_s','source_time_s','source_sample_index','velocity_m_s','RSSI_percent','overrange')
NAME = re.compile(r'(\d+)号叶片[_\s-]*(\d+(?:\.\d+)?)度', re.I)
POINT = re.compile(r'^P\d+(?=$|[_\s-])', re.I)

def archive_name(info):
    # Some macOS ZIP creators write UTF-8 names without setting bit 11.
    # Decode only a lossless UTF-8 round trip; preserve ordinary CP437 names.
    if not info.flag_bits & 0x800:
        try:
            return info.filename.encode('cp437').decode('utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return info.filename

def point_metadata(header, name):
    """Use the exported point, never stale sourcePointLabel or a distance in the batch name."""
    point = header.get('point') or (header.get('pointCycle') or {}).get('radialPointName')
    if not isinstance(point, str) or not point.strip():
        point = next((m[0].upper() for part in reversed(PurePosixPath(name).parts)
                      if (m := POINT.match(part))), '')
    radius = header.get('radiusM', (header.get('pointCycle') or {}).get('radiusM'))
    if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
        radius = None
    return {'pointName': point.strip(), 'radiusM': radius}

def text(value, name):
    if not isinstance(value,str) or not value.strip() or len(value)>200:
        raise SignalError('IMPORT_MAPPING_REQUIRED', '请填写'+name)
    return value.strip()

def parse(blob, name):
    with gzip.GzipFile(fileobj=io.BytesIO(blob)) as stream:
        data=stream.read(LIMIT+1)
    if len(data)>LIMIT:raise ValueError('解压后超过256 MB')
    source=data.decode('utf-8-sig');lines=source.splitlines()
    if not lines or not lines[0].startswith('# BladeVMS '):raise ValueError('缺少 BladeVMS 文件头')
    header=json.loads(lines[0][len('# BladeVMS '):])
    if not isinstance(header,dict):raise ValueError('文件头必须是 JSON 对象')
    if FORMAT not in (header.get('format'),header.get('schema'),header.get('schemaVersion')):raise ValueError('文件格式不是 '+FORMAT)
    fs=header.get('sampleRate');n=header.get('samples')
    if isinstance(fs,bool) or not isinstance(fs,(float,int)) or not math.isfinite(fs) or fs<=0:raise ValueError('采样率无效')
    if type(n) is not int or not 2<=n<=2_000_000:raise ValueError('每文件需要2～200万个样本')
    reader=csv.DictReader(lines[1:])
    if not reader.fieldnames or set(COLUMNS)-set(reader.fieldnames):raise ValueError('缺少列：'+', '.join(set(COLUMNS)-set(reader.fieldnames or [])))
    values=np.empty((n,6))
    for i,row in enumerate(reader):
        if i>=n:raise ValueError('实际行数超过 samples')
        values[i]=[float(row[k]) for k in COLUMNS]
    if 'i' not in locals() or i+1!=n:raise ValueError('实际行数与 samples 不一致')
    local,source_t,index=values[:,:3].T
    if not np.all(np.isfinite(values[:,:3])) or np.any(np.diff(local)<=0):raise ValueError('时间必须有限且递增')
    if not np.all(index==np.floor(index)) or np.any(np.diff(index)!=1) or index[0]<0:raise ValueError('来源样本编号必须连续递增')
    start,end=header.get('sourceSampleStart'),header.get('sourceSampleEndExclusive')
    if type(start) is not int or type(end) is not int or start!=index[0] or end-start!=n:raise ValueError('来源起止样本与数据不一致')
    grid=np.arange(n)/fs
    if not np.allclose(local-local[0],grid,rtol=0,atol=max(1e-9,1e-3/fs)) or not np.allclose(source_t-source_t[0],grid,rtol=0,atol=max(1e-9,1e-3/fs)):raise ValueError('时间与采样率不一致，不能拼成连续段')
    match=NAME.search(Path(name).name)
    angle=float(match[2]) if match else None
    if angle is not None and not 0<=angle<360:raise ValueError('文件名角度须在0～360°之间')
    return header,values,{'bladeId':match[1] if match else '', 'azimuthDeg':angle}

def stage(manager, path):
    paths = path if isinstance(path, list) else [path]
    if not 1 <= len(paths) <= 20 or any(not isinstance(p, str) for p in paths):
        raise ValueError('请选择1～20个数据包或一个文件夹')
    sources = [Path(p).resolve() for p in paths]
    if len(set(sources)) != len(sources) or (len(sources)>1 and any(p.suffix.lower()!='.zip' for p in sources)):
        raise ValueError('多选仅支持不重复的ZIP数据包')
    token=uuid.uuid4().hex;folder=manager.root/'imports'/token;folder.mkdir(parents=True)
    files=[];manifests={};total=0
    def retain(name,blob):
        nonlocal total
        total+=len(blob)
        if total>LIMIT:raise ValueError('导入包超过256 MB')
        if name.lower().endswith('.json'):
            if len(blob)>1024*1024:raise ValueError('清单文件过大')
            manifests[name]=json.loads(blob);return
        fid=uuid.uuid4().hex;original=folder/(fid+'.csv.gz');original.write_bytes(blob)
        item={'fileId':fid,'fileName':name,'sha256':hashlib.sha256(blob).hexdigest()}
        try:
            head,values,mapping=parse(blob,name);item.update(mapping,**point_metadata(head,name),samples=len(values),sampleRate=head['sampleRate'],header=head)
            native=np.zeros(len(values),dtype=RECORD_DTYPE);native['index']=np.arange(len(values));native['velocity']=values[:,3]
            native['rssi']=values[:,4];native['flags']=np.where(np.isfinite(values[:,4]),2,0)|np.where(~np.isfinite(values[:,5])|(values[:,5]!=0),1,0)
            # Unknown absolute clock stays unknown; never substitute import time.
            epoch=head.get('sourceSampleOrigin',head.get('sampleOrigin'))
            epoch=epoch if isinstance(epoch,(float,int)) and not isinstance(epoch,bool) and math.isfinite(epoch) and epoch>0 else None
            # Epoch refers to the original continuous capture. Add its sample
            # offset once, never the import clock or an already shifted time.
            origin=epoch+int(head['sourceSampleStart'])/float(head['sampleRate']) if epoch is not None else 0.
            (folder/(fid+'.bin')).write_bytes(HEADER.pack(MAGIC,float(head['sampleRate']),origin,0)+native.tobytes())
            item.update(overrangeSamples=int(np.count_nonzero(native['flags']&1)),missingRssiSamples=int(np.count_nonzero(native['flags']&2==0)),sampleOrigin=origin,sourceClock={'localTimeStartSeconds':float(values[0,0]),'sourceTimeStartSeconds':float(values[0,1]),'sourceSampleStart':int(values[0,2]),'sourceSampleEndExclusive':int(values[-1,2])+1,'sampleRate':head['sampleRate'],'sourceEpoch':epoch})
        except (ValueError,TypeError,OSError,EOFError,KeyError,OverflowError) as exc:item['error']=str(exc)
        files.append(item)
    try:
        for source in sources:
            prefix = source.name+'/' if len(sources)>1 else ''
            if source.is_dir():
                files_in_dir=sorted(p for p in source.rglob('*') if p.is_file() and (p.name.lower().endswith('.csv.gz') or p.suffix.lower()=='.json'))
                if not 1<=len(files_in_dir)<=250:raise ValueError('目录最多支持200个分段和50份清单')
                for p in files_in_dir:
                    if p.is_symlink() or not p.resolve().is_relative_to(source):raise ValueError('不支持链接文件')
                    if p.stat().st_size>LIMIT:raise ValueError('文件过大')
                    retain(p.relative_to(source).as_posix(),p.read_bytes())
            elif source.suffix.lower()=='.zip':
                with zipfile.ZipFile(source) as z:
                    infos=z.infolist()
                    # Bundles may also contain duplicate point ZIPs and plots.
                    # Budget the members we actually read; never decompress
                    # ignored nested archives or count their duplicate data.
                    readable=[i for i in infos if not i.is_dir() and not archive_name(i).startswith('__MACOSX/')
                              and not PurePosixPath(archive_name(i)).name.startswith('._')
                              and archive_name(i).lower().endswith(('.csv.gz','.json'))]
                    if len(infos)>1000 or sum(i.file_size for i in readable)>LIMIT:raise ValueError('压缩包过大')
                    for i in infos:
                        name=archive_name(i);p=PurePosixPath(name)
                        if p.is_absolute() or '..' in p.parts or '\\' in name or (i.external_attr>>16)&0o170000==0o120000:raise ValueError('压缩包路径不安全')
                        if not i.is_dir() and not name.startswith('__MACOSX/') and not p.name.startswith('._') and (name.lower().endswith('.csv.gz') or name.lower().endswith('.json')):retain(prefix+name,z.read(i))
            else:raise ValueError('请选择 ZIP 或分段文件夹')
        if not files or len(files)>200:raise ValueError('需要1～200个 CSV.GZ 分段文件')
        state={'token':token,'files':files,'sourceManifests':manifests,'createdAt':time.time()};atomic_json(folder/'stage.json',state)
        defaults = {'name': sources[0].stem if len(sources)==1 else ''}
        for key in ('windFarm', 'turbine'):
            values = {str(f['header'][key]).strip() for f in files if not f.get('error') and f['header'].get(key)}
            defaults[key] = next(iter(values)) if len(values)==1 else ''
        return {'token':token,'defaults':defaults,'files':[{k:v for k,v in f.items() if k not in ('header','sampleOrigin','sourceClock')} for f in files]}
    except Exception:
        shutil.rmtree(folder);raise

def commit(manager, body):
    if set(body)-{'action','token','name','windFarm','turbine','pointName','radiusM','files'}:raise ValueError('不支持的导入字段')
    token=body.get('token','')
    if not isinstance(token,str) or not ID.fullmatch(token):raise ValueError('导入预览已失效，请重新选择文件')
    folder=manager.root/'imports'/token;state=json.loads((folder/'stage.json').read_text())
    if (folder/'completed.json').exists():return json.loads((folder/'completed.json').read_text())
    name=text(body.get('name'),'任务名称');farm=text(body.get('windFarm'),'风场');turbine=text(body.get('turbine'),'风机')
    mappings=body.get('files')
    if not isinstance(mappings,list) or not mappings or len(mappings)>200:raise ValueError('请选择有效分段')
    collection=uuid.uuid4().hex;prepared=[];slots=set();seen=set();point_radii={};sources={f['fileId']:f for f in state['files']}
    for mapping in mappings:
        if not isinstance(mapping,dict):raise ValueError('分段映射无效')
        fid=mapping.get('fileId');f=sources.get(fid)
        if f is None or f.get('error') or fid in seen:raise ValueError('分段无效或重复')
        seen.add(fid);blade=text(mapping.get('bladeId'),'叶片编号');angle=mapping.get('azimuthDeg')
        point=text(mapping.get('pointName',body.get('pointName') or f.get('pointName')),'测点')
        radius=mapping.get('radiusM',body.get('radiusM',f.get('radiusM')))
        if radius is not None and (isinstance(radius,bool) or not isinstance(radius,(float,int)) or not math.isfinite(radius) or radius<=0):raise ValueError('测点半径须为正数，未知可留空')
        if point in point_radii and radius!=point_radii[point]:raise ValueError('同一测点的距离必须一致')
        point_radii[point]=radius
        if isinstance(angle,bool) or not isinstance(angle,(int,float)) or not math.isfinite(angle) or not 0<=angle<360:raise ValueError('角度须在0～360°之间')
        if f.get('bladeId') and (blade!=f['bladeId'] or angle!=f['azimuthDeg']):raise ValueError('可识别的文件名是叶片和角度的依据，不可静默改写')
        if (blade,point,angle) in slots:raise ValueError('同一叶片、测点和角度重复，请仅选择一份')
        slots.add((blade,point,angle));rid=uuid.uuid4().hex;head=f['header']
        m={'id':rid,'name':name,'windFarm':farm,'turbine':turbine,'point':point,'object':'风机叶片','measurementMode':'outdoor','status':'complete','unit':'m/s','format':'BLADEV01/<QidifB','samples':f['samples'],'sampleRate':f['sampleRate'],'sampleOrigin':f['sampleOrigin'],'startedAt':f['sampleOrigin'] or None,'endedAt':f['sampleOrigin']+f['samples']/f['sampleRate'] if f['sampleOrigin'] else None,'chunks':1,'overrangeSamples':f['overrangeSamples'],'missingRssiSamples':f['missingRssiSamples'],'rssiSampleStride':1,'rssiSampleRate':f['sampleRate'],'source':'split_segment_import','importedAt':time.time(),
           'diagnosticOnly':head.get('diagnosticOnly',True),'validMeasurement':head.get('validMeasurement',False),
           'importSource':{'format':FORMAT,'fileName':f['fileName'],'sha256':f['sha256'],'importId':token,'originalHeader':head,'manifestContent':state['sourceManifests'],'originalManifests':{k:hashlib.sha256(json.dumps(v,sort_keys=True).encode()).hexdigest() for k,v in state['sourceManifests'].items()}},
           'outdoorSegment':{'schema':FORMAT,'rawFile':'split-source.csv.gz','sourceClock':f['sourceClock'],'mappingSource':'file_name' if f.get('bladeId') else 'user_confirmed','sourceRecordingId':head.get('sourceRecordingId'),'originalCaptureKey':head.get('physicalCaptureId')},
           'pointCycle':{'collectionId':collection,'bladeId':blade,'radialPointId':hashlib.sha256((blade+'\0'+point).encode()).hexdigest()[:32],'radialPointName':point,'radiusM':radius,'azimuthDeg':angle,'identityVerified':head.get('identityVerified',False)}}
        prepared.append((f,m))
    planned=[{k:m['pointCycle'][k] for k in ('bladeId','radialPointId','radialPointName','radiusM','azimuthDeg')} for _,m in prepared]
    made=[]
    try:
        manager.recordings.mkdir(parents=True,exist_ok=True)
        for f,m in prepared:
            m['pointCycle']['plannedStations']=[p for p in planned if p['bladeId']==m['pointCycle']['bladeId']]
            tmp=folder/(m['id']+'.pending');tmp.mkdir();shutil.copyfile(folder/(f['fileId']+'.bin'),tmp/'chunk-00000000.bin');shutil.copyfile(folder/(f['fileId']+'.csv.gz'),tmp/'split-source.csv.gz');atomic_json(tmp/'manifest.json',m)
            target=manager.recordings/m['id'];tmp.rename(target);made.append(target)
        key=task_key(prepared[0][1]);result={'taskId':hashlib.sha256(key.encode()).hexdigest()[:32],'recordingIds':[m['id'] for _,m in prepared],'measurementMode':'outdoor','imported':len(prepared)}
        atomic_json(folder/'completed.json',result);return result
    except Exception:
        for p in made:shutil.rmtree(p)
        raise
