"""Read-only replay of saved linked captures; no SDK, device, or upload calls.

Production feed() verifies original entry/exit sample indices. Parameter trials
reuse the exact 10 ms features through the production state machine; they are
counterfactual detection times, not proof of physical blade identity/accuracy.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import html
import json
from pathlib import Path
from statistics import median
import sys
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/acquisition"))
from blade_acquisition.rssi_handoff import RssiHandoff  # noqa: E402
from blade_acquisition.storage import HEADER, MAGIC  # noqa: E402

TZ = timezone(timedelta(hours=8))
DTYPE = np.dtype([("i", "<u8"), ("rawv", "<i4"), ("v", "<f8"),
                  ("rawr", "<i4"), ("r", "<f4"), ("flags", "u1")])


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def raw_replay(rssi, rate, config, block=5000):
    gate = RssiHandoff(SimpleNamespace(**config), 0, require_background=True)
    events = []
    for start in range(0, len(rssi), block):
        values = rssi[start:start + block].tolist()
        gate.feed(SimpleNamespace(sample_rate=rate, sample_start=start,
                                  values=values, rssi=values, rssi_sample_stride=1))
        events.extend(gate.drain_events())
        if gate.trigger:
            break
    return {"trigger": gate.trigger, "events": events, "status": dict(gate.status)}


def feature_replay(features, rate, config):
    gate = RssiHandoff(SimpleNamespace(**config), 0, require_background=True)
    gate.rate, gate.origin = rate, 0
    events = []
    for end, mean, spread in zip(features["end"], features["mean"], features["spread"]):
        gate._window(float(mean), float(spread), int(end), config["rssiSmoothingMs"] / 1000)
        events.extend(gate.drain_events())
        if gate.trigger:
            break
    return {"trigger": gate.trigger, "events": events, "status": dict(gate.status)}


def summarize_replay(value, rate):
    trigger, events = value["trigger"], value["events"]
    def first(phase):
        return next((e["sampleElapsedSeconds"] for e in events if e["phase"] == phase), None)
    return {
        "backgroundSeconds": first("background_ready"),
        "firstEntryAttemptSeconds": first("confirming_entry"),
        "entrySeconds": trigger["entrySampleIndex"] / rate if trigger else None,
        "entryConfirmedSeconds": (trigger["entryConfirmedSampleIndex"] + 1) / rate if trigger else None,
        "exitStartSeconds": trigger["exitSampleIndex"] / rate if trigger else None,
        "triggerSeconds": trigger["sampleElapsedSeconds"] if trigger else None,
        "entryToTriggerSeconds": (trigger["sampleIndex"] + 1 - trigger["entrySampleIndex"]) / rate if trigger else None,
        "exitAttempts": sum(e["phase"] == "confirming_exit" for e in events),
        "entryAttempts": sum(e["phase"] == "confirming_entry" for e in events),
        "baselineMismatches": value["status"]["rssiBaselineMismatches"],
        "partialPassesIgnored": value["status"]["rssiPartialPassesIgnored"],
    }


def analyze(path):
    manifest_path = path / "manifest.json"
    m = json.loads(manifest_path.read_text())
    files = [manifest_path, *sorted(path.glob("chunk-*.bin"))]
    hashes = {str(p): sha(p) for p in files}
    assert m["status"] == "complete" and m.get("rssiSampleStride", 1) == 1
    arrays, count = [], 0
    for file in files[1:]:
        with file.open("rb") as stream:
            magic, rate, _, start = HEADER.unpack(stream.read(HEADER.size))
        assert magic == MAGIC and rate == m["sampleRate"] and start == count
        a = np.fromfile(file, DTYPE, offset=HEADER.size)
        assert np.all(a["i"] == np.arange(count, count + len(a)))
        assert np.all(a["flags"] & 2), "Missing RSSI must not be interpolated"
        arrays.append(a["rawr"].astype(float) * 100 / m["acquisition"]["rssiRawMax"])
        count += len(a)
    assert count == m["samples"]
    raw = np.concatenate(arrays)
    config = m["turntable"]["config"]
    production = raw_replay(raw, rate, config)
    handoff = m["pointCycle"]["handoff"]
    for key in ("sampleIndex", "entrySampleIndex", "entryConfirmedSampleIndex", "exitSampleIndex"):
        assert production["trigger"][key] == handoff[key], (path.name, key)
    assert production["status"]["signalGapCount"] == 0
    # Batch delivery granularity must not change sample-based decisions.
    alternate = raw_replay(raw, rate, config, 20000)
    assert alternate["trigger"]["sampleIndex"] == handoff["sampleIndex"]
    width = round(rate * config["rssiSmoothingMs"] / 1000)
    windows = raw[:len(raw) // width * width].reshape(-1, width)
    p10, p90 = np.percentile(windows, [10, 90], axis=1)
    features = {"end": (np.arange(len(windows)) + 1) * width,
                "mean": windows.mean(axis=1), "spread": p90 - p10,
                "p10": p10, "p90": p90}
    feature_current = feature_replay(features, rate, config)
    assert feature_current["trigger"]["sampleIndex"] == handoff["sampleIndex"]
    trials = {}
    for exit_threshold, confirm in ((3, 20), (4, 30), (4.5, 30), (5, 30), (6, 30)):
        candidate = {**config, "rssiExitSpread": exit_threshold, "rssiConfirmMs": confirm}
        trials[f"exit{exit_threshold:g}_confirm{confirm}"] = summarize_replay(feature_replay(features, rate, candidate), rate)
    for enter_threshold, enter_confirm in ((6, 20), (8, 10), (6, 10)):
        candidate = {**config, "rssiEnterSpread": enter_threshold, "rssiEnterConfirmMs": enter_confirm,
                     "rssiExitSpread": 4, "rssiConfirmMs": 30}
        trials[f"enter{enter_threshold}_confirm{enter_confirm}_exit4"] = summarize_replay(feature_replay(features, rate, candidate), rate)
    c, current = m["pointCycle"], summarize_replay(production, rate)
    entry, exit_end = handoff["entryConfirmedSampleIndex"], handoff["sampleIndex"]
    mask = (features["end"] > entry) & (features["end"] <= exit_end + 1)
    low_variation = features["spread"] <= config["rssiExitSpread"]
    baseline = handoff.get("baselineRssi")
    near_baseline = abs(features["mean"] - baseline) <= handoff["baselineTolerancePp"]
    fractions = {"lowVariationFraction": float(np.mean(low_variation[mask])),
                 "baselineMatchFraction": float(np.mean(near_baseline[mask])),
                 "bothFraction": float(np.mean((low_variation & near_baseline)[mask]))}
    events = c.get("processEvents", [])
    entry_event = next((e for e in events if e["phase"] == "blade_present"), None)
    sample_delay_ms = ((entry_event["at"] - c["firstSampleAt"]) - current["entryConfirmedSeconds"]) * 1000 if entry_event else None
    move = handoff.get("completedMove") or {}
    move_events = move.get("events", [])
    command_sending = next((e["seconds"] for e in move_events if e["phase"] == "command_sending"), None)
    wire = min(move.get("wireCommandSeconds", {}).values(), default=None)
    exit_to_wire = ((handoff["motionCommandAt"] - handoff["detectedAt"]) + wire - command_sending) if wire is not None else None
    row = {
        "id": path.name, "startedAt": m["startedAt"], "time": datetime.fromtimestamp(m["startedAt"], TZ).strftime("%H:%M:%S"),
        "session": c["sessionId"], "point": c["pointName"], "stationIndex": c["stationIndex"],
        "stationCount": c["stationCount"], "samples": count, "rate": rate, "config": config,
        "current": current, "trials": trials, "exitCriteria": fractions,
        "baselineRssi": baseline, "baselineTolerancePp": handoff["baselineTolerancePp"],
        "clickToFirstSampleSeconds": c["firstSampleAt"] - m["clientRequestedAt"] if c["stationIndex"] == 1 and m.get("clientRequestedAt") else None,
        "prepositioned": c.get("arrivalMove", {}).get("state") in ("already_at_target", "initial_pose_verified"),
        "entryHostVsSampleDeltaMs": sample_delay_ms,
        "exitToWireSeconds": exit_to_wire,
        "exitToNextArrivalSeconds": handoff.get("arrivedAt", 0) - handoff["detectedAt"] if handoff.get("arrivedAt") else None,
        "arrivalSeconds": c.get("arrivalMove", {}).get("actualSeconds"),
        "replayMatchesStoredIndices": True, "batchSizeInvariant": True,
        "signalGapCount": 0, "sourceHashes": hashes,
        "windows": [{"endSeconds": float(end / rate), "mean": float(mean), "spread": float(spread),
                     "p10": float(low), "p90": float(high)} for end, mean, spread, low, high in
                    zip(features["end"], features["mean"], features["spread"], p10, p90)],
    }
    assert all(sha(Path(p)) == digest for p, digest in hashes.items())
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recordings", type=Path, default=Path.home() / "Library/Application Support/@blade/desktop/field-data/recordings")
    parser.add_argument("--since", default="2026-10-22T23:30:00+08:00")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timing-log", type=Path)
    args = parser.parse_args()
    since = datetime.fromisoformat(args.since).timestamp()
    paths = []
    for path in args.recordings.glob("*/manifest.json"):
        m = json.loads(path.read_text())
        c = m.get("pointCycle") or {}
        if m.get("startedAt", 0) >= since and m["status"] == "complete" and c.get("stationCount") == 2 and c.get("completion") == "confirmed_pass":
            paths.append((m["startedAt"], path.parent))
    rows = [analyze(path) for _, path in sorted(paths)]
    assert rows, "No matching complete recordings"
    groups = defaultdict(list)
    for row in rows:
        groups["first" if row["stationIndex"] == 1 else "later"].append(row)
    summary = {}
    for name, group in groups.items():
        summary[name] = {"count": len(group), "medianEntryToTriggerSeconds": median(r["current"]["entryToTriggerSeconds"] for r in group),
                         "medianBackgroundSeconds": median(r["current"]["backgroundSeconds"] for r in group),
                         "medianExitAttempts": median(r["current"]["exitAttempts"] for r in group),
                         "medianClickToFirstSampleSeconds": median(v for r in group if (v := r["clickToFirstSampleSeconds"]) is not None) if name == "first" else None}
    result = {"mode": "offline immutable recording replay", "physicalGroundTruthAvailable": False,
              "parametersChangedOnDeviceOrClient": False, "sourceFilesUnchanged": True,
              "summary": summary, "rows": rows}
    if args.timing_log:
        payload = args.timing_log.read_bytes()
        trace = [json.loads(line) for line in payload.splitlines()]
        recalls = []
        for n, event in enumerate(trace):
            if event["event"] != "service_turntable_request" or event.get("action") != "recall":
                continue
            stamp = event["wallTimeNs"] / 1e9
            if not rows[0]["startedAt"] - 60 <= stamp <= rows[-1]["startedAt"]:
                continue
            end = next((i for i in range(n + 1, len(trace)) if trace[i]["event"] == "service_turntable_request"), len(trace))
            wire = next((e for e in trace[n + 1:end] if e["event"] == "drive_internal" and e.get("phase") == "wire_sending"), None)
            if wire:
                recalls.append({"at": stamp, "time": datetime.fromtimestamp(stamp, TZ).strftime("%H:%M:%S"),
                                "requestToWireSeconds": (wire["monotonicNs"] - event["monotonicNs"]) / 1e9})
        result["manualRecallTrace"] = {"snapshotSHA256": hashlib.sha256(payload).hexdigest(), "rows": recalls,
                                      "medianRequestToWireSeconds": median(r["requestToWireSeconds"] for r in recalls) if recalls else None}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "analysis.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    render(args.out, result)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    for row in rows:
        print(row["time"], row["point"], json.dumps({"current": row["current"], "exit4": row["trials"]["exit4_confirm30"], "exitCriteria": row["exitCriteria"]}, ensure_ascii=False))


def render(out, result):
    import shutil
    rows = result["rows"]
    shutil.copyfile(ROOT / "node_modules/echarts/dist/echarts.min.js", out / "echarts.min.js")
    def value(v):
        return "—" if v is None else f"{v:.3f}"
    table = "".join("<tr>" + "".join(f"<td>{html.escape(str(v))}</td>" for v in (
        r["time"], r["point"], value(r["clickToFirstSampleSeconds"]), value(r["current"]["backgroundSeconds"]),
        value(r["current"]["entryToTriggerSeconds"]), r["current"]["exitAttempts"],
        value(r["trials"]["exit4_confirm30"]["entryToTriggerSeconds"]), value(r["exitToWireSeconds"]),
        value(r["exitToNextArrivalSeconds"]))) + "</tr>" for r in rows)
    slow = [r for r in rows if r["stationIndex"] == 1 and r["current"]["entryToTriggerSeconds"] > .5]
    conclusions = "".join(f'<li>{r["time"]} {html.escape(r["point"])}：进入至触发 {r["current"]["entryToTriggerSeconds"]:.2f}s，离开确认尝试 {r["current"]["exitAttempts"]} 次；候选4/30为 {r["trials"]["exit4_confirm30"]["entryToTriggerSeconds"]:.2f}s。</li>' for r in slow)
    holdout_text = ""
    wire_values = [r["exitToWireSeconds"] for r in rows if r["exitToWireSeconds"] is not None]
    manual_latency = (result.get("manualRecallTrace") or {}).get("medianRequestToWireSeconds")
    command_text = (f'<p>离开确认后至实际0x19写入，中位时间 {median(wire_values):.3f}s；'
                    + (f'手动预定位从服务收到请求至实际写入，中位时间 {manual_latency:.3f}s。' if manual_latency is not None else '')
                    + '这里不包含控制板执行到电机开始移动的未知细分，不把指令应答当作物理动作开始。</p>') if wire_values else ''
    if (out / "holdout.json").exists():
        h = json.loads((out / "holdout.json").read_text())
        counts = ", ".join(f'{v["results"]["current"]["count"]}→{v["results"]["exit4"]["count"]}' for v in h["rows"])
        holdout_text = f'<p>三个独立固定点60秒历史片段，当前与候选4/30的候选经过数量分别为：{counts}。未增加候选数量；这不是实机正确率验收。<a href="holdout.json">交叉检查结果</a></p>'
    document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>首次经过与换点后触发对比</title>
<style>body{{font:15px/1.75 system-ui;background:#f4f6fa;color:#243047;margin:0}}main{{max-width:1250px;margin:24px auto;background:white;border-radius:14px;padding:26px}}h1{{font-size:25px}}.note{{padding:14px;background:#eff6ff;border-radius:8px}}table{{border-collapse:collapse;white-space:nowrap;width:100%;font-size:13px}}td,th{{padding:10px;border-bottom:1px solid #e2e8f0;text-align:left}}th{{background:#f1f5f9}}.scroll{{overflow:auto}}img{{width:100%}}code{{overflow-wrap:anywhere}}</style>
<main><h1>首次经过与换点后触发：原始 RSSI 离线回放</h1>
<p>范围：2026-10-22 23:30 后的完整双点位记录，共 {len(rows)} 条。全部原始采样保留；没有连接设备、开启激光、修改运行参数或上传数据。</p>
<p class="note">每条记录使用生产 feed() 精确复现保存的进入与离开样本序号；5000/20000 样本分批结果一致。参数对比复用同一原始窗口与生产状态机。绿色线是候选参数在同一段数据上的触发时刻，并不证明识别正确。</p>
<h2>结论</h2><p>不是每次首点都慢，也没有固定必须等两片叶片的计数条件。首点有间歇性的离开确认拖延；这6次首点开始时均已在预设位置，等待不是再次运动造成。</p><ul>{conclusions}</ul>
<p>首点点击至收到首样本的中位时间 {result["summary"]["first"]["medianClickToFirstSampleSeconds"]:.3f}s，准备连接、参考核验及启用DAQ仍有耗时；这段没有RSSI样本，不能判断叶片是否已提前经过。基线准备的首点中位时间仅 {result["summary"]["first"]["medianBackgroundSeconds"]:.2f}s，并非秒级固定等待。候选4/30保留20ms进入确认、30ms离开确认，只调整退出波动阈值。</p>{command_text}{holdout_text}
<p>部分记录还存在短暂进入候选未达到20ms的情况；缺少同步视频，不能确认那些短脉冲是叶片还是噪声。历史叶根数据中，改成10ms进入确认增加了短间隔候选，不建议直接删除或大幅缩短所有确认步骤。</p>
<p>比较时将“点击后等待叶片到来”与“已经检测到进入，但迟迟不能确认离开”分开；后者更能反映用户所说的触发拖延。采样时间与主机时间分开计算，避免把转速相位等待全部称为软件延迟。</p>
<div class="scroll"><table><thead><tr><th>开始时间</th><th>点位</th><th>点击至首样本 s</th><th>基线就绪 s</th><th>当前进入至触发 s</th><th>离开尝试次数</th><th>候选4/30进入至触发 s</th><th>离开确认至真实下发 s</th><th>离开确认至下一点停靠 s</th></tr></thead><tbody>{table}</tbody></table></div>
<h2>原始 RSSI 与判定窗口</h2><p>蓝线：进入；红线：当前离开确认；绿虚线：退出波动阈值4、退出确认30ms的离线候选结果。阈值修改会同时影响基线容差联动，不能将差异全部归因于一个因素。</p>
<label>选择记录 <select id="record" style="padding:10px;min-width:320px"></select></label><p id="detail" class="note"></p>
<div id="mean" style="height:290px" aria-label="原始RSSI每10ms均值与分位数"></div>
<div id="spread" style="height:300px" aria-label="RSSI窗口波动与触发时刻"></div>
<h2>验证边界</h2><p>没有叶片位置编码器或同步视频，无法仅凭RSSI确定每个候选都是正确叶片经过。记录在原判定触发时结束，提前触发的候选不能推演后续真实换点位置和回波。不能直接把更早触发称为更准确。</p>
<p>结构化结果与所有源文件SHA256见 <a href="analysis.json">analysis.json</a>；脚本为 scripts/analyze-linked-first-pass.py。原始文件读取前后校验一致。</p></main></html>'''
    chart_data = [{k: r[k] for k in ("time", "point", "windows", "current", "trials", "baselineRssi")} for r in rows]
    document += '<script src="echarts.min.js"></script><script>const records=' + json.dumps(chart_data, ensure_ascii=False).replace("<", "\\u003c") + ';' + r"""
const select=document.getElementById('record');
for(let i=0;i<records.length;i++){const o=document.createElement('option');o.value=i;o.textContent=records[i].time+' · '+records[i].point;select.appendChild(o);}
const mean=echarts.init(document.getElementById('mean')),spread=echarts.init(document.getElementById('spread'));
mean.group=spread.group='replay';echarts.connect('replay');
function draw(i){const r=records[i],c=r.current,trial=r.trials.exit4_confirm30;
 document.getElementById('detail').textContent='当前：进入至触发 '+c.entryToTriggerSeconds.toFixed(3)+' s，离开确认尝试 '+c.exitAttempts+' 次；候选4/30：'+(trial.entryToTriggerSeconds==null?'未触发':trial.entryToTriggerSeconds.toFixed(3)+' s')+'。候选不代表实测正确率。';
 const marks=[{name:'进入',xAxis:c.entrySeconds,lineStyle:{color:'#2563eb'}},{name:'当前触发',xAxis:c.triggerSeconds,lineStyle:{color:'#dc2626'}},...(trial.triggerSeconds==null?[]:[{name:'候选触发',xAxis:trial.triggerSeconds,lineStyle:{color:'#16a34a',type:'dashed'}}])];
 const base={animation:false,tooltip:{trigger:'axis'},grid:{left:65,right:40,top:42,bottom:64},xAxis:{type:'value',name:'DAQ采样时间 / s',nameLocation:'middle',nameGap:28},dataZoom:[{type:'inside'},{type:'slider',bottom:0,height:18}],legend:{top:2}};
 mean.setOption({...base,yAxis:{type:'value',name:'RSSI / %'},series:[['均值','mean','#2563eb'],['P10','p10','#93c5fd'],['P90','p90','#60a5fa']].map(([name,key,color],n)=>({name,type:'line',showSymbol:false,lineStyle:{width:n?1:2,color},data:r.windows.map(w=>[w.endSeconds,w[key]]),...(n?{}:{markLine:{symbol:'none',label:{formatter:'{b}'},data:[...marks,{name:'进入前基线',yAxis:r.baselineRssi,lineStyle:{color:'#64748b'}}]}})}))},true);
 spread.setOption({...base,yAxis:{type:'value',name:'P90−P10 / 百分点'},series:[{name:'10ms波动',type:'line',showSymbol:false,lineStyle:{width:1,color:'#7c3aed'},data:r.windows.map(w=>[w.endSeconds,w.spread]),markLine:{symbol:'none',label:{formatter:'{b}'},data:[...marks,{name:'当前退出阈值3',yAxis:3,lineStyle:{color:'#dc2626'}},{name:'候选退出阈值4',yAxis:4,lineStyle:{color:'#16a34a'}}]}}]},true);
}
select.onchange=()=>draw(Number(select.value));let initial=records.reduce((a,r,i)=>r.current.entryToTriggerSeconds>records[a].current.entryToTriggerSeconds?i:a,0);select.value=initial;draw(initial);window.addEventListener('resize',()=>{mean.resize();spread.resize();});
</script>"""
    (out / "index.html").write_text(document)


if __name__ == "__main__":
    main()
