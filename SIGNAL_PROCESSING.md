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

### 恒定 RPM 台架旋转分析

现场工作台的“旋转测振”页面提供 `constant-rpm-model` 验证模式。它适用于室内风机模型或
离线算法回归：用户输入固定 RPM、分析时间区间和每转重采样点数，服务从完整原始记录按
恒定转频建立角度网格，计算实际阶次谱和每转同步平均。它不读取或伪造键相脉冲。

接口为 `POST /api/field/rotation`，请求示例：

```json
{
  "recordingIds": ["0123456789abcdef0123456789abcdef"],
  "rpm": 1200,
  "startSeconds": 0,
  "endSeconds": 5,
  "pointsPerRevolution": 256,
  "maxOrder": 20,
  "targetOrder": 1,
  "phaseOffsetDeg": 0,
  "maxRevolutions": 50,
  "positions": [0.2],
  "pointNames": ["P1"]
}
```

`recordingIds` 最多 8 条，服务取它们的共同时间区间；不同采样率会先分别读取连续原始
样本，再插值到同一个角度网格。`pointsPerRevolution` 必须是 64～4096 的 2 的整数次幂。
分析至少需要两个完整转数，且阶次上限必须小于每转点数的一半。

返回结果包括：

- `orderSpectra`：每条记录的 `{orders, amplitudes}`，幅值来自角度重采样后的真实保存波形；
- `synchronousAverages`：每条记录按转数分块后的 `angleDegrees` 与平均 `values`；
- `modeShape.points`：目标阶次的幅值、相对第一测点的相位、跨转相干性和归一化复数分量；
- `provenance`：记录 ID、原始采样率、读取区间和原始数据追溯信息；
- `warnings`：固定 RPM、`t=0` 同相以及独立记录并非硬件同步等限制。

单条记录可以得到阶次谱和同步平均，但不能得到空间振型。多条记录的相对相位只有在
它们确实由同一触发或已完成时间延迟标定时才有物理意义；当前页面默认使用 `t=0` 同相，
因此结果必须标记为模型验证。接入真实 RPM/键相后，应保留此返回结构，只替换角度网格
生成方式，并增加脉冲质量、每转边界和硬件时间戳字段。

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

## 恒转速模型：振型模板、匹配评分与三维动画（1.1.0）

桌面“旋转测振”计算完成后，新增“振型重构与候选模态匹配”。这是**工作响应形状**
与理想模型的比较，不是实验模态识别。2 倍转频的响应不等于第二阶固有模态。

### 操作

1. 选择已保存的多点记录，填写固定 RPM、整数融合目标阶次和各点真实的 `x/L`。
   至少需要 3 个不同的非根部测点（如 0.2、0.6、0.9），建议 5～8 点覆盖叶展。
   根部零响应不提供模态区分信息，不能把三个实际测点任意重映射为 0、0.5、1。
2. 点击“开始恒转速分析”，查看四阶弯曲模板的 MAC、归一化复数 MSE 和候选提示。
3. 点击“查看第 N 阶”切换比较曲线。三维图可选测点复响应或理论模板，默认暂停；
   支持播放/暂停、相位滑动、播放速度、显示变形和视角调节。
4. 原“导出结果 JSON”按钮同时导出 `modalMatch`，包含理论曲线、评分及全部限制。
   老版本 Python 服务不返回该字段时，界面提示升级，不补造结果。

### 计算公式

- **理论库**：均匀 Euler–Bernoulli 悬臂梁，根部固支、叶尖自由，仅单方向弯曲。
  `φ_n(x) = cosh(β_n x) − cos(β_n x) − σ_n [sinh(β_n x) − sin(β_n x)]`，
  `σ_n = (cosh β_n + cos β_n)/(sinh β_n + sin β_n)`。
  `x` 为 `x/L`；前四根 `β = 1.875104, 4.694091, 7.854757, 10.995541`。
  除以 `φ_n(1)`，使叶尖为 +1。未输入弹性模量、密度、截面和长度，因而**不计算固有频率**。
- **速度转位移**：目标频率 `f = 目标阶次 × RPM / 60`，复位移 `D = V/(j 2πf)`，
  幅值单位 m，界面显示 μm。只转换所选谐波，不是对完整波形做无约束积分。
- **相位与归一化**：取最大响应测点作为相位参考（避免根部节点相位未定义），
  整组复位移统一旋转并除以最大幅值，得到复向量 `z`。这不修复异步采集的相位误差。
- **MAC**：在实际测点取理论向量 `φ`，
  `MAC = |φᴴ z|² / [(φᴴ φ)(zᴴ z)]`。范围 0～1，保留相位反转；不是分类置信概率。
- **拟合误差**：`c = (φᴴ z)/(φᴴ φ)`，`normalizedMse = mean(|z − cφ|²)`。
  比较图显示测点与拟合理论的实、虚部。MSE 是无量纲残差，不是 m²；在本缩放方法下
  它与 MAC 相关，不应当作两项独立的识别证据。
- **排序与歧义**：按 MAC 选首位；MAC < 0.8 或首位与次位差 < 0.05 标记 `ambiguous`。
  这些是未经过现场标定的演示提示阈值，不是验收判据。低覆盖、少测点另有警告。
- **三维图**：以 `Re[z(x) exp(jθ)]` 生成归一化弯曲响应；测点间对实、虚部分别线性插值。
  未测根部补零是固支假设，最外测点之后保持灰色参考，不外推。理论预览使用完整模板。
  采用三维坐标投影的 SVG 示意网格，无真实叶片网格、厚度或扭转自由度。
  “显示变形 %L”只是归一化几何比例，不是物理放大倍数；0.1～2 Hz 播放速度与实际频率无关。

### `modalMatch` 返回字段

| 字段 | 含义 |
|---|---|
| `model` | `uniform-cantilever-euler-bernoulli`，理想悬臂梁 |
| `status` / `message` | `candidate` 候选、`ambiguous` 不明确、`insufficient-data` 不参与评分及原因 |
| `candidateMode` / `macGap` | 排序首位模板编号、前两名 MAC 差；不可评分时 null |
| `frequencyHz` | 被分析的响应频率，不是识别出的固有频率 |
| `maxDisplacementAmplitude` / `displacementAmplitudes` | 最大及各测点位移幅值，单位 m |
| `referencePointIndex` | 最大响应参考点在输入记录中的索引，从 0 起 |
| `pointNames` | 与输入记录同序的测点名称，不按位置重新编号 |
| `positions` / `measuredReal` / `measuredImag` | 输入测点位置及共同比例归一化后的复位移响应 |
| `curvePositions` | 0～1 共 161 个理论绘图位置 |
| `candidates[].mode` / `beta` | 1～4 阶弯曲模板编号及梁特征根 |
| `theoryAtPoints` / `theoryCurve` | 测点处/完整绘图网格的单位叶尖理论响应 |
| `mac` / `normalizedMse` | 相位敏感的相似度与归一化残差；不可评分时 null |
| `fittedReal` / `fittedImag` | 同一复系数缩放后的理论测点响应；不可评分时 null |
| `fittedCurveReal` / `fittedCurveImag` | 缩放后的理论绘图曲线；不可评分时 null |
| `warnings` | 共同相位、测点覆盖、模型边界与动画限制 |

测点不足、位置重复、零/近零响应或非整数目标阶次时仍返回理论库，但不排名。
不能将该结果宣称为已识别扭转、损伤、固有频率或阻尼。特别是分别采集的记录，
没有共同触发/参考点/键相时，即便 MAC 接近 1 也只能作为假设验证。

### 验证（Windows cmd，项目根目录）

```bat
npm run typecheck
npm run test:field
npm run build -w @blade/desktop
npm run test:bending-desktop
```

桌面验证默认使用 `services\acquisition\.venv-build\Scripts\python.exe`，可通过
`set "BLADE_VALIDATION_PYTHON=完整的python.exe路径"` 切换。脚本创建临时账号和六条明确标记
simulation 的二阶梁响应，不访问安装版数据，不启动硬件；验证真实 Electron→IPC→Python
计算、模板切换、动画播放/暂停和 1024px 布局。结果与截图保存于
`artifacts/bending-validation/`。Python 测试还覆盖前四阶模板、相位尺度不变性、零响应、
重复位置、相位错误、低相似度和位移单位。
