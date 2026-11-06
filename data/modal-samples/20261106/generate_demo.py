"""Offline numerical demonstration. Never imports datasets into the product database.

Run with the acquisition Python environment: generate_demo.py --repo REPOSITORY
All generated data and plots are explicitly labelled synthetic.
"""
from pathlib import Path
import argparse, base64, csv, gzip, hashlib, html, io, json, subprocess, sys, zipfile
import numpy as np
from scipy import signal, linalg
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
root = Path(__file__).resolve().parent
for name in ['数据', '结果', '图表']:
    (root/name).mkdir(exist_ok=True)
sys.path.insert(0, str(repo/'services/acquisition'))
from blade_acquisition.record_analysis.modal_engine import compute, mac
from blade_acquisition.record_analysis.reference.cli import json_safe

font = next((p for p in [Path('/System/Library/Fonts/PingFang.ttc'),
                        Path('/System/Library/Fonts/STHeiti Light.ttc')] if p.exists()), Path('missing'))
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams['font.family'] = font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams.update({'axes.unicode_minus': False, 'figure.dpi': 130, 'font.size': 10})
NOTICE = '仿真演示 · 非现场实测 · 不用于验收证明或健康判定'
SEED = 20261106
rng = np.random.default_rng(SEED)

def dump(path, value):
    path.write_text(json.dumps(json_safe(value, include_arrays=True), ensure_ascii=False,
                               indent=None, allow_nan=False), encoding='utf-8')

# Read only files tracked by Git, not earlier local imports or saved analysis results.
tracked = subprocess.check_output(['git', 'ls-files', '-z', 'data/task-imports/20261105'], cwd=repo).decode().split('\0')
archives = sorted(p for p in tracked if p.endswith('/叶片1.zip'))
sources, textures, stats_rows = [], [], []
for relative in archives:
    archive = repo/relative
    with zipfile.ZipFile(archive) as z:
        for member in sorted(z.namelist()):
            # Two angles at each of five points, in both source tasks: twenty segments.
            if not member.endswith(('1号叶片_0度.csv.gz', '1号叶片_90度.csv.gz')):
                continue
            blob = z.read(member)
            text = gzip.decompress(blob).decode('utf-8-sig')
            head, body = text.split('\n', 1)
            meta = json.loads(head.split(' ', 2)[2])
            a = np.loadtxt(io.StringIO(body), delimiter=',', skiprows=1, usecols=(3, 4, 5))
            valid = np.isfinite(a[:, 0]) & (a[:, 2] == 0)
            x = a[valid, 0]
            if len(x) < 100:
                continue
            # Statistics refer only to whole supplied segments, not certified vibration cores.
            x = signal.detrend(x)
            scale = float(1.4826*np.median(abs(x-np.median(x))))
            hp = x-signal.savgol_filter(x, 501, 2)
            noise_scale = float(1.4826*np.median(abs(hp-np.median(hp))))
            lag = float(np.corrcoef(hp[:-1], hp[1:])[0, 1])
            row = {'sourceTask': Path(relative).parent.name, 'archive': relative, 'member': member,
                   'csvGzSha256': hashlib.sha256(blob).hexdigest(), 'point': meta['point'],
                   'samples': len(a), 'sampleRateHz': meta['sampleRate'], 'durationSeconds': len(a)/meta['sampleRate'],
                   'segmentResidualRobustScale_m_s': scale, 'highpassNoiseScale_m_s': noise_scale,
                   'highpassLag1': lag, 'rssiZeroFraction': float(np.mean(a[:, 1] == 0)),
                   'diagnosticOnly': meta.get('diagnosticOnly'), 'identityVerified': meta.get('identityVerified'),
                   'wholeSegmentOnly': True}
            sources.append(row)
            stats_rows.append(row)
            textures.append(hp[::10][:4096]/max(noise_scale, 1e-12))

if not sources:
    raise RuntimeError('No tracked reference segments found')
scale = float(np.median([s['segmentResidualRobustScale_m_s'] for s in sources]))
correlation = float(np.clip(np.median([s['highpassLag1'] for s in sources]), 0, .95))
# Empirical texture is a display model only; replay does not extend actual observations.
pool = np.concatenate(textures)
def noise(n, amplitude):
    # Bootstrap short blocks, filter and re-scale; generated clock and correlations are artificial.
    starts = rng.integers(0, len(pool)-64, size=(n+63)//64)
    y = np.concatenate([pool[s:s+64] for s in starts])[:n]
    y = signal.lfilter([1], [1, -correlation], y)
    return y/max(np.std(y), 1e-12)*amplitude

provenance = {'notice': NOTICE, 'synthetic': True, 'seed': SEED,
              'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip(),
              'referenceSegments': sources, 'referenceScale_m_s': scale, 'noiseAR1': correlation,
              'assumedNaturalFrequencyHz': [.75, 2.0], 'assumedDampingRatios': [.025, .04],
              'positionFractions': [.1, .3, .5, .7, .9],
              'assumptionNotice': '频率、阻尼、振型、共同采样时钟、激励力和撤除激励均由模型设定，未由户外短片段识别。',
              'scaleNotice': '整段去线性趋势的稳健量级只用于演示缩放，可能仍含运动、背景和仪器误差；不是纯振动实测幅值。',
              'noiseNotice': '参考片段高通纹理经块重采样与人工滤波，不能视作新测量或真实同步相关性。'}
dump(root/'数据'/'仿真来源与假设.json', provenance)
with (root/'数据'/'Git参考片段统计.csv').open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=list(stats_rows[0]))
    writer.writeheader(); writer.writerows(stats_rows)

def channel(i, values, quantity='velocity', role='response'):
    return {'id': str(i), 'pointId': 'P'+str(i) if role=='response' else '模拟力输入',
            'role': role, 'quantity': quantity, 'unit': 'N' if quantity=='force' else 'm/s',
            'direction': 'axial', 'calibrationSource': 'SIMULATED MODEL UNITS; NOT INSTRUMENT CALIBRATION',
            'values': values.tolist()}

def dataset(t, channels, evidence):
    return {'schemaVersion': 'modal-input-1', 'sourceKind': 'numerical_validation_only',
            'time_s': t.tolist(), 'channels': channels, 'evidence': evidence,
            'provenance': {'synthetic': True, 'notice': NOTICE, 'seed': SEED}}

plots, summaries = [], []
def savefig(fig, name, caption):
    fig.suptitle(caption+'\n'+NOTICE, fontsize=12)
    fig.tight_layout(rect=[0, .02, 1, .90])
    path = root/'图表'/(name+'.png')
    fig.savefig(path, bbox_inches='tight'); plt.close(fig)
    plots.append((caption, path))

def run(name, data, method, truth):
    # The outer envelope is intentionally not a production modal-input-1 document.
    dump(root/'数据'/(name+'_仿真输入.json'), {'schemaVersion': 'modal-demo-bundle-1',
         'synthetic': True, 'notice': NOTICE, 'truth': truth, 'dataset': data})
    columns = ['time_s']+[c['pointId']+'_'+c['unit'].replace('/', '_') for c in data['channels']]
    with (root/'数据'/(name+'_仿真时序.csv')).open('w', encoding='utf-8-sig', newline='') as f:
        f.write('# '+NOTICE+'\n')
        writer = csv.writer(f); writer.writerow(columns)
        writer.writerows(zip(data['time_s'], *(c['values'] for c in data['channels'])))
    result = compute(data, method)
    result.update(synthetic=True, notice=NOTICE, truth=truth, healthConclusion=None)
    targets = np.atleast_1d(truth['frequencyHz'])
    for mode in result['modes']:
        relative_error = float(np.min(abs(targets-mode['naturalFrequencyHz'])/targets))
        mode['demoModelMatch'] = '匹配预设模态（仅仿真）' if relative_error < .04 else '噪声或数值稳定极点，待复核，不计入预设模态'
    dump(root/'结果'/(name+'_仿真计算结果.json'), result)
    for mode in result['modes']:
        summaries.append({'method': method, 'frequencyHz': mode['naturalFrequencyHz'],
                          'dampingPercent': 100*mode['dampingRatio'], 'shapeAvailable': bool(mode.get('shape')),
                          'synthetic': True, 'modelMatch': mode['demoModelMatch']})
    print(name, [(round(m['naturalFrequencyHz'], 5), round(m['dampingRatio'], 5)) for m in result['modes']], flush=True)
    return result

# 1. Single-mode free decay; force removal occurs in the simulation, not in a field experiment.
fs = 32.; t = np.arange(int(fs*60))/fs; fn = .75; zeta = .025; wn = 2*np.pi*fn
y = scale*3*np.exp(-zeta*wn*t)*np.sin(wn*np.sqrt(1-zeta*zeta)*t+.2)
y += noise(len(t), scale*.00015)
dec = run('01_自由衰减', dataset(t, [channel(5, y)],
          {'excitationRemoved': True, 'excitationRemovalSource': 'SIMULATION ONLY: forcing set to zero at model t=0'}),
          'decay', {'frequencyHz': fn, 'dampingRatio': zeta, 'observationSeconds': 60})
e = dec['evidence']; fig, axs = plt.subplots(3, 1, figsize=(12, 11))
axs[0].plot(e['time_s'], e['response'], lw=.7, label='仿真响应'); axs[0].plot(e['time_s'], e['fittedResponse'], lw=.6, alpha=.7, label='算法拟合')
axs[0].set(xlabel='模型时间 / s', ylabel='速度 / (m/s)'); axs[0].legend()
axs[1].scatter(e['peakTime_s'], np.log(e['peakAmplitude']), s=12, label='仿真同相峰值')
axs[1].plot(e['peakTime_s'], e['fittedLogAmplitude'], label='对数包络拟合'); axs[1].legend()
axs[1].set(xlabel='模型时间 / s', ylabel='ln(幅值 / 1 m/s)')
axs[2].scatter(e['peakTime_s'], e['logResidual'], s=12); axs[2].axhline(0, color='gray', lw=.8)
axs[2].set(xlabel='模型时间 / s', ylabel='对数包络残差')
savefig(fig, '01_自由衰减_包络与残差', '自由衰减：响应、包络与残差')

# 2. SDOF force/velocity FRF with exact model clock, broadband force and small colored noise.
n = 65536; t = np.arange(n)/fs; w = 2*np.pi*np.fft.rfftfreq(n, 1/fs)
F = rng.normal(0, 100, n)
H = 1j*w/(wn**2-w**2+2j*zeta*wn*w)
Y = np.fft.irfft(np.fft.rfft(F)*H, n=n)
gain = scale/max(np.std(Y), 1e-12); Y *= gain
Y += noise(n, scale*.002)
frf = run('02_FRF', dataset(t, [channel(0, F, 'force', 'excitation'), channel(5, Y)],
          {'synchronization': 'common_sample_clock', 'clockSource': 'SIMULATED exact common numerical grid'}),
          'frf', {'frequencyHz': fn, 'dampingRatio': zeta, 'responseGain': gain,
                  'forceRmsN': 100, 'forceRmsIsAssumed': True, 'observationSeconds': n/fs})
e = frf['evidence']; fig, axs = plt.subplots(2, 1, figsize=(12, 8))
sel = e['frequencyHz'] <= 3
axs[0].plot(e['frequencyHz'][sel], e['frfMagnitude'][sel], lw=.9, label='仿真 H1 FRF')
axs[0].plot(e['fitFrequencyHz'], e['fitMagnitude'], '--', label='SDOF 拟合')
axs[0].plot(e['halfPowerCrossingsHz'], [e['halfPowerLevel']]*2, 'o-', label='半功率交点')
axs[0].set(xlabel='频率 / Hz', ylabel='速度 FRF / (m/s)/N'); axs[0].legend()
axs[1].plot(e['frequencyHz'][sel], e['coherence'][sel]); axs[1].set(xlabel='频率 / Hz', ylabel='相干性 γ²', ylim=(0, 1.05))
savefig(fig, '02_FRF_拟合与相干性', 'FRF：半功率带宽与力—响应相干性')

# 3. Five physically coupled simulated outputs of a two-mode cantilever-like model.
fs = 25.; n = 30000; freqs = np.array([.75, 2.]); zetas = np.array([.025, .04])
x = np.array([.1, .3, .5, .7, .9]); shapes = []
for beta in [1.8751040687, 4.6940911330]:
    sigma = (np.cosh(beta)+np.cos(beta))/(np.sinh(beta)+np.sin(beta))
    phi = np.cosh(beta*x)-np.cos(beta*x)-sigma*(np.sinh(beta*x)-np.sin(beta*x))
    shapes.append(phi/np.max(abs(phi)))
shapes = np.array(shapes).T
A = linalg.block_diag(*[np.array([[0, 1], [-(2*np.pi*f)**2, -2*z*2*np.pi*f]]) for f,z in zip(freqs, zetas)])
B = np.array([[0, 0], [(2*np.pi*freqs[0])**2, 0], [0, 0], [0, (2*np.pi*freqs[1])**2]])
C = np.column_stack((np.zeros(5), shapes[:, 0], np.zeros(5), shapes[:, 1]))
system = signal.cont2discrete((A, B, C, np.zeros((5, 2))), 1/fs)
_, y, _ = signal.dlsim(system, rng.normal(size=(n+2500, 2)))
y = y[2500:]; y *= scale/np.median(np.std(y, axis=0))
for j in range(5):
    y[:, j] += noise(n, max(np.std(y[:, j])*.001, scale*.0001))
t = np.arange(n)/fs
ssi = run('03_SSI_COV', dataset(t, [channel(j+1, y[:, j]) for j in range(5)],
          {'synchronization': 'common_sample_clock', 'clockSource': 'SIMULATED state-space simultaneous outputs',
           'ambientExcitationAssumption': True, 'excitationAssumptionSource': 'SIMULATED independent stationary broadband loads'}),
          'ssi_cov', {'frequencyHz': freqs.tolist(), 'dampingRatios': zetas.tolist(), 'modeShapes': shapes.tolist(),
                      'positionFractions': x.tolist(), 'observationSeconds': n/fs})
for j, f in enumerate(freqs):
    mode = min(ssi['modes'], key=lambda m: abs(m['naturalFrequencyHz']-f))
    if abs(mode['naturalFrequencyHz']/f-1) > .04 or mac(np.array(mode['shapeReal'])+1j*np.array(mode['shapeImag']), shapes[:, j]) < .95:
        raise RuntimeError('SSI model consistency check failed')
e = ssi['evidence']; poles = e['candidatePoles']; fig, axs = plt.subplots(2, 2, figsize=(14, 10))
for stable, color, label in [(False, '#b4bdc7', '未稳定'), (True, '#1262a5', '稳定')]:
    ps = [p for p in poles if p['stable']==stable]
    axs[0, 0].scatter([p['naturalFrequencyHz'] for p in ps], [p['order'] for p in ps], s=12, c=color, label=label)
axs[0, 0].set(xlabel='固有频率 / Hz', ylabel='模型阶次', xlim=(0, 4)); axs[0, 0].legend()
axs[0, 1].semilogy(np.arange(1, len(e['singularValues'])+1), e['singularValues'], '.-')
axs[0, 1].set(xlabel='序号', ylabel='Hankel 奇异值（对数轴）')
ps = [p for p in poles if p.get('exclusionReason') is None]
axs[1, 0].scatter([p['naturalFrequencyHz'] for p in ps], [100*p['dampingRatio'] for p in ps], s=12)
axs[1, 0].set(xlabel='固有频率 / Hz', ylabel='阻尼比 / %', xlim=(0, 4))
for mode in ssi['modes']:
    if mode['naturalFrequencyHz'] > 4: continue
    matched = mode['demoModelMatch'].startswith('匹配')
    axs[1, 1].plot(x, mode['shapeReal'], 'o-' if matched else 'x--',
                  label=f"{mode['naturalFrequencyHz']:.3f} Hz "+('仿真识别实部' if matched else '噪声极点待复核'))
axs[1, 1].axhline(0, color='gray', lw=.7)
axs[1, 1].set(xlabel='沿叶展归一化位置 r/L（P1～P5）', ylabel='归一化振型'); axs[1, 1].legend(fontsize=8)
savefig(fig, '03_SSI_稳定图奇异值阻尼振型', '工作模态：稳定图、奇异值、阻尼与五测点振型')
fig, axs = plt.subplots(5, 1, figsize=(13, 10), sharex=True)
sel = t < 40
for j, ax in enumerate(axs):
    ax.plot(t[sel], y[sel, j], lw=.7); ax.set_ylabel(f'P{j+1}\nm/s')
axs[-1].set_xlabel('共同模型时间 / s；连续1200 s的前40 s')
savefig(fig, '04_SSI_五点仿真同步波形', '五个测点的仿真同步波形（不是原始分段的时间对齐结果）')

dump(root/'结果'/'仿真识别参数汇总.json', summaries)
rows = ''.join(f"<tr><td>{r['method']}</td><td>{r['frequencyHz']:.5f}</td><td>{r['dampingPercent']:.3f}</td><td>{'有' if r['shapeAvailable'] else '单响应无完整振型'}</td><td>{r['modelMatch']}</td></tr>" for r in summaries)
images = ''.join('<section><h2>'+html.escape(c)+'</h2><img src="data:image/png;base64,'+base64.b64encode(p.read_bytes()).decode()+'" alt="'+html.escape(c)+'"></section>' for c,p in plots)
page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模态参数仿真演示</title><style>body{font-family:system-ui;max-width:1300px;margin:32px auto;padding:0 24px;color:#182432}aside{padding:18px;background:#fff0c7;border-left:5px solid #bd7100}img{width:100%;height:auto}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{padding:12px;border:1px solid #cdd4dc}h2{margin-top:36px}</style><h1>模态参数识别 · 仿真演示</h1><aside><strong>'+NOTICE+'</strong><p>参考 Git 户外短片段的量级、噪声纹理及五测点布置；0.75/2.0 Hz、2.5%/4%阻尼和模态形状是人为模型假设，不能当作该风机识别结果。没有导入 Web 实测数据区，也没有修改产品代码。</p><p>有色噪声也可能产生跨阶稳定极点；表中已标注未匹配模型的候选，它们不能作为真实结构模态。</p></aside><table><tr><th>方法</th><th>仿真识别频率 Hz</th><th>仿真识别阻尼 %</th><th>振型</th><th>模型核验</th></tr>'+rows+'</table>'+images+'</html>'
(root/'仿真图表预览.html').write_text(page, encoding='utf-8')
print('DONE', root, flush=True)
