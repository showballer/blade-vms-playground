# 真实速度数据的信号处理

本实现位于 `validation/simulation-rotation` 分支。桌面侧栏“信号处理”调用本机
Python 分析接口，读取已完成记录的 BLADEV01 原始分块。现有安装的旧 EXE 不会因源码
变更而自动升级，必须同时更新桌面构建和 Python 服务。

## 使用与输入边界

1. 完成真实采集，点击“停止并保存”。
2. 打开“信号处理”，选择已完成记录，指定半开区间 `[start,end)`，即含 start、不含 end。
3. 选择物理量、去趋势、滤波、FFT 点数、STFT 窗长和频带，点击“开始分析”。
4. 切换时域、FFT、时频、滤波、包络、频带和特征值；导出 JSON 保存计算参数、版本与原始区间哈希。

默认速度单位 m/s，计算位移 m，计算加速度 m/s²。RSSI 单位 %，只是光学回波质量，
不参与振动频谱和能量计算。选择速度时，若希望保留直流均值，应明确选择“不去趋势”。

一次分析 64～8,000,000 个样本，采样率取原始记录；不允许选择文件外的区间，
不允许用浏览器预览包络/抽点或 WS 跳点批次代替连续原始样本。缺块、序号异常、
采样率/时间基准不一致、非有限值、超量程样本均报错；不自动补点或删点。
RSSI 缺失不阻止完整速度区间分析，但返回缺失计数。
本地连续性并不证明设备网络无丢包，返回 `dataLossAssessment=unverified`。

## 时间和频率分辨能力

设速度为 `v[i]`，采样率为 `fs`：`dt=1/fs`，区间内时间为 `(start+i)/fs` 秒。
N 个样本覆盖 `N/fs` 秒。NFFT 点频谱栅格为 `df=fs/NFFT`，窗函数还会影响实际分辨能力。
增加零填充不会增加实测时长；本版不做零填充，也不把不连续样本拼接。

例如：218750 Hz 下1000点只有4.57 ms，栅格约218.75 Hz，不能分析0.6 Hz。
本版 NFFT 最大262144，218750 Hz时最小栅格约0.8345 Hz，仍不适合精细分析0.6 Hz。
长记录可用于时域特征，但要更精细的低频 FFT，后续需增加经过抗混叠滤波的降采样，
或提高受控的 FFT 长度上限；本版不会将短窗结果伪装成低频高分辨结果。

## 实际计算流程

顺序固定：原始速度 → 去趋势 → 可选滤波 → 物理量转换 → 图谱/特征。
原始数据只读。显示的“滤波降噪”对比始终是原始速度和预处理后速度，单位 m/s；
其余分析使用所选物理量。改参数会清空旧结果，必须重新计算。

### 去趋势和滤波

- 去均值：`v0[i]=v[i]-mean(v)`。
- 去线性趋势：最小二乘拟合 `a*i+b` 并从原信号减掉；它会影响极低频分量。
- 滤波使用 SciPy Butterworth IIR 二阶节 `butter(...,output='sos')` 和
  `sosfiltfilt`。低通保留下限以下频率，高通保留上限以上频率的说法容易混淆：
  本界面“低通”使用 `highHz` 截止，“高通”使用 `lowHz` 截止，带通使用二者。
- 带通要求 `0 < lowHz < highHz < fs/2`；阶数1～10，为设计时的单向原型阶数。
  双向处理零相位，但幅频响应是单向的平方，最终截止处并非单向的 -3 dB。
  带通转换还会增加滤波器阶数，不能将参数阶数当作最终双向总阶数。
- 这是离线滤波，使用前后数据；端点存在边界效应。不会宣称自动提高了多少 dB 信噪比。
  本版没有 FIR、自动毛刺/异常删除功能。

### 计算位移、加速度

设预处理后的速度为 `u[i]`。

位移用梯形积分：`d[0]=0`，`d[i]=d[i-1]+(u[i]+u[i-1])*dt/2`，随后去线性漂移。
计算位移强制先去均值或线性趋势。它表示相对振动位移，不包含绝对位置、直流位移，
去漂移也可能削弱真实低频运动。

加速度用中心差分：`a[i]=(u[i+1]-u[i-1])/(2*dt)`，端点为二阶单边差分。
高频噪声会被放大，建议先低通/带通；微分的高频幅值存在离散化误差。

校验例：`v(t)=A*sin(2*pi*f*t)`，位移幅值应约为 `A/(2*pi*f)`，
加速度幅值约为 `A*2*pi*f`。测试用已知32 Hz正弦检查换算后的 RMS。

### FFT 幅值谱

取所选区间起点的首 NFFT 点，乘周期窗 `w[i]`，计算实数 FFT：
`X[k]=rfft(x*w)`。单边峰值幅值为 `2*abs(X[k])/sum(w)`；DC 与偶数长度的
奈奎斯特点不乘2。Hann、Hamming、矩形窗可选。窗增益校正适用于对齐频率栅格的
正弦峰值；非整周期信号仍有泄漏和栅格偏差，不能保证峰值恰好等于真实幅值。

主频定义为此幅值谱除 DC 外幅值最大的频率栅格，幅值近零时返回 null。
主频不是自动测得的转频，也不直接代表损伤或固有频率。

### STFT 时频图

每个短窗加同一窗函数并做单边幅值 FFT，幅值校正同上。
时间坐标使用各窗中心在原记录中的秒数。
默认约50%重叠；长区间为限制返回量增大步进，最多约128列，步进大于窗长时明确警告。
频率最多128组，显示每组最大幅值，颜色是线性幅值（所选物理量单位），不是 dB 或 PSD。
分组中心频率只是显示坐标，精确频率请查 FFT；稀疏时频视图不能保证捕获所有瞬态。

### 包络谱

对整个预处理/转换后的区间做 Hilbert 解析信号：`e[i]=abs(hilbert(x))[i]`。
去掉 `mean(e)`，取首 NFFT 点计算单边幅值谱。实际冲击解调应先选合适的带通频带；
否则宽带干扰也会进入包络。端点存在有限记录效应。
测试用 `(1+0.3*cos(2*pi*16*t))*cos(2*pi*256*t)`，应在包络谱还原16 Hz、幅值0.3。

### 频带功率与占比

用 Welch 方法计算 PSD：窗长=NFFT、50%重叠、不重复去趋势，`scaling='density'`。
使用选定区间内所有完整窗，尾部不足一窗且未被完整窗覆盖的样本不进入 Welch 估计。
PSD 单位为 `(所选单位)²/Hz`。频带功率 `Pband=sum(PSD[k])*df`，
频带按 `[low,high)`，最后上限恰为 fs/2 时包含奈奎斯特点。

总功率 `Ptotal` 对0～fs/2求和，占比 `100*Pband/Ptotal`。频带不允许重叠；
未覆盖全部频率时占比之和可小于100%；全零信号占比为 null。频带没有栅格点时提示
分辨率不足。这里是信号均方量/功率指标，不是焦耳意义的叶片机械能。

### 时域特征

全部使用所选区间的处理后信号 x，N 为区间样本数：

| 字段 | 定义 | 单位 |
|---|---|---|
| mean | sum(x)/N | 所选单位 |
| rms | sqrt(sum(x²)/N) | 所选单位 |
| peak | max(abs(x)) | 所选单位 |
| peakToPeak | max(x)-min(x) | 所选单位 |
| kurtosis | mean((x-mean)⁴)/mean((x-mean)²)² | 无量纲；非超额峭度，不减3，零方差时null |
| dominantHz | 首 NFFT 点非 DC 最大幅值栅格 | Hz |
| totalPower | Welch PSD 对0～fs/2积分 | 所选单位的平方 |
| snrDb | 未实现，缺明确的信号/噪声定义 | null |

同步平均需要可靠的周期和相位/键相参考，本版返回 null 并在“平均波形”标签说明。
不根据 RSSI 换算 SNR，不生成未经验证的损伤、转速、叶片编号、质量评级。

## 接口、追溯与显示

### 采集中实时预览

采集期间 `GET /api/field/frame` 在原有 `waveform` 外附带 `realtime`。服务从内存环形窗口复制最近最多 4096 个 CH1 速度样本，在采集锁外计算 Hann 窗单边 FFT，以及均值、RMS、绝对峰值、峰峰值和主频。窗口少于 64 点、采样率无效或数据非有限时，`available=false`；不会补点、插值或读取尚未完成的原始分块。前端按现有 0.25～1 秒刷新周期显示在线指标和频谱，原始采集线程不等待浏览器绘图。

实时 FFT 是观察用途：频率栅格为 `fs/N`，主频只是最近窗口中最大的频率栅格，不是转频、阶次或损伤结论。在线计算不做零相位滤波、位移积分、同步平均、RPM/键相跟踪或报警判断；停止后仍须使用完整记录的离线分析接口获得可追溯结果。`realtime` 不写入原始文件，也不改变记录完整性判断。

示例字段：

```json
{
  "realtime": {
    "available": true,
    "sampleRate": 218750,
    "sampleStart": 100000,
    "sampleCount": 4096,
    "windowSamples": 4096,
    "frequencySpacingHz": 53.40576171875,
    "features": {"mean": 0.0, "rms": 0.00012, "peak": 0.00031, "peakToPeak": 0.00062, "dominantHz": 32.0},
    "spectrum": {"frequencies": [], "amplitudes": []},
    "warnings": ["实时结果使用最近窗口；停止采集后请使用完整记录进行离线分析。"]
  }
}
```

`POST /api/field/recordings/{id}/analysis`，继承本机令牌、Host/Origin 检查。
Electron IPC 使用 `{action:'analysis', id, parameters}`，不允许任意文件路径。

```json
{
  "start": 0, "end": 16384,
  "quantity": "velocity", "detrend": "constant",
  "filterType": "none", "lowHz": 1, "highHz": 100, "order": 4,
  "window": "hann", "nfft": 4096, "stftSize": 1024,
  "bands": [[0,10],[10,30],[30,80]]
}
```

返回 `features`、`waveform`、`rawVelocity`、`filteredVelocity`、`spectrum`、
`envelopeSpectrum`、`bands`、`stft`、`warnings`。曲线包含 x/y 和 representation；
计算完成后才进行最多约1800点的极值显示压缩，压缩结果不可作为二次分析的原始输入。
JSON 导出包含这些显示图数据及精确计算特征，不是完整原始数据导出。

`provenance` 包含记录ID、来源、原始时间起点、RSSI缺失计数、超量程计数和
所选区间原始结构化记录字节的 SHA-256。`parameters`、`algorithmVersion`、
NumPy/SciPy版本、计算时间和频率栅格一并返回。相同哈希表示选区原始数据相同，
算法版本和参数仍须一起核对。HTTP 409表示已有分析在运行；422表示数据或参数不适合分析。

## Windows cmd 验证

在项目根目录执行（独立虚拟环境，不修改系统 Python/Conda）：

```bat
python -m venv services\acquisition\.venv
services\acquisition\.venv\Scripts\python -m pip install -r services\acquisition\requirements.txt httpx==0.28.1
npm ci
npm run build -w @blade/desktop
npm run test:analysis-desktop
```

手动查看隔离验证窗口：

```bat
npm run validate:analysis-desktop
```

它创建独立临时账号/目录，以明确标记 simulation 的32 Hz+128 Hz原始记录运行真实
Electron→HTTP→Python分析；禁止真实采集与设备控制，不读取或覆盖安装版的数据。
截图和数值结果在 `artifacts/analysis-validation/`，不是现场测量证据。

算法与服务回归（项目根目录）：

```bat
cd services\acquisition
.venv\Scripts\python -m unittest discover -s tests -v
```

正式 EXE 必须按原有 Windows 构建流程重建采集服务（新增 NumPy/SciPy）及桌面包，
仅重建前端不能给旧服务增加分析接口。此分支未宣称完成设备精度、同步、损伤识别验收。
