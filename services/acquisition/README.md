# BladeVMS 本机采集服务

面向 Windows x64 的真实 IVS-500 采集与 macOS/Windows 显式模拟调试服务。桌面 Electron 主进程负责启动/关闭它；不注册 Windows 常驻服务，不要求最终用户安装 Python。真实与模拟使用同一保存/波形/分析链路，来源始终明确标记，不存在缺设备时的自动模拟回退。

SDK 适配器源自同事项目 `damage_detection/backend/app/polytec_receiver.py`，保留已有 C API 调用约定、通道标识、量程换算与 UDP 解码方式；原项目未修改。厂商 DLL、驱动和安装包未复制进代码仓库，分发许可和所需系统组件仍需 Windows 联调确认。

## 安全与职责

- 启动即 `idle`，不会加载 SDK、连接设备、修改 DAQ 目标、点亮激光或开始采集。
- 真实设备仅在显式 `POST /api/field/start` 且 `confirmLaser: true` 后开始。该确认表示操作者已经完成激光安全检查，允许将设备 DAQ 目标改为指定本机网卡 IP，并开启激光。省略 `source` 仍为真实设备路径；显式 `source: "simulation"` 才启用模拟，模拟无需激光确认且不实例化设备适配器。
- 一次采集会话独占控制激光；停止/错误收尾时尝试停止 DAQ 并关闭激光，不恢复此前可能已经开启的激光状态。开启激光命令超时也视作不确定失败，并尝试关闭。
- 如果设备断连或 SDK 拒绝关闭激光，状态为 `error`，必须现场确认激光状态，不承诺已经关闭。
- 连续 10 秒无有效振动样本会报错并收尾；磁盘写入失败也会停止采集。没有自动重连、自动重启采集或隐藏的模拟回退。
- 原始采样由 Python 自行落盘。HTTP/WS 只负责显示窗口，关闭曲线、断开 WS 或丢掉显示帧不影响原始保存路径。

## 启动契约

开发入口：在本目录运行 `python -m blade_acquisition`。打包入口为 `BladeAcquisition.exe`。由桌面主进程通过子进程环境传入：

| 环境变量 | 约束 |
|---|---|
| `BLADE_SERVICE_TOKEN` | 必填，至少 32 字符的随机令牌；不得写入日志、URL或渲染进程。不是用户登录密码 |
| `BLADE_SERVICE_PORT` | 本机端口，1024–65535，默认 8765；由主进程选择可用端口 |
| `BLADE_DATA_DIR` | 必填，应用专用、可写的绝对目录；原始数据位于其 `recordings` 子目录 |
| `BLADE_POLYTEC_DLL` | 厂商 x64 `DeviceCommunication.dll` 的绝对路径；可不传，但此时开始真实设备采集会明确报错，不影响显式模拟采集 |

仅绑定 `127.0.0.1`，无热重载、单 worker、无公开文档端点、无自动运行设备。禁止启用多个服务进程共同写同一数据目录。进程退出时走 FastAPI lifespan 收尾；Windows 正常退出必须先调用 stop、确认没有 `error` 且记录已完成，再终止服务。强制杀进程不等于安全关闭设备。

全部 HTTP 接口使用 `Authorization: Bearer <token>`，只接受本端口 `127.0.0.1` / `localhost` Host；拒绝外部网页 Origin 和 `null` Origin。Electron 应通过主进程代理调用，不让渲染进程直接拿令牌。无 Origin 的本机主进程请求允许访问。

## HTTP / WebSocket

| 接口 | 请求与结果 |
|---|---|
| `GET /api/field/status` | 当前状态，不会启动设备 |
| `GET /api/field/frame` | 状态 + 速度/RSSI 显示窗口 + `realtime`；默认取最近 2048 点，指定 `window_ms=1..1000` 时显示对应窗口：不超过 4096 点返回全部原始点，更长窗口返回最多 1000 个保留峰值的包络桶 |
| `GET /api/field/realtime` | 状态 + 最近最多 4096 个连续原始点的时域、FFT、STFT 与指标；最多每 250 ms 计算一次 |
| `GET /api/field/simulation` | 3 个源工作簿测点、4 个回放场景及文件/脚本 SHA-256 来源信息；不启动采集 |
| `POST /api/field/start` | JSON：`deviceIp`、`hostIp`、`name`、`object`、`turbine`、`point`、`confirmLaser: true`；可附 `turntable: {port, axis, speedRpm, direction, durationSeconds}` 与 `confirmMotion: true` 启用真实连续转盘联动；返回状态，真正启动在后台进行 |
| `POST /api/field/stop` | 无必需请求体；等待停止、关激光和本地数据收尾，最长约 20 秒；返回最终状态 |
| `GET /api/field/turntable/ports` | 列出本机 COM 串口；不会连接或运动 |
| `POST /api/field/turntable` | `action: "probe" | "stop"`、`port`、`axis`；`stop` 必须 `confirmMotion: true`。仅显式 `confirmRecovery: true` 才能清除上次未确认停止状态 |
| `GET /api/field/recordings` | `{ recordings: [...] }`，最新最多 1000 条本机记录，离线可读 |
| `GET /api/field/recordings/{id}` | `{ recording, waveform }`，仅允许服务生成的 UUID ID，读取有限预览，不接受文件路径 |
| `GET /api/field/recordings/{id}/export` | 完整已保存原始样本的流式 CSV，首行来源 JSON；不降采样；未完成记录返回 409 |
| `WS /ws/field` | `Sec-WebSocket-Protocol: blade,<token>`，服务选择 `blade`；每 250 ms 发送与 frame 相同结构 |

错误：未授权 401，外部 Origin/Host 403，参数/未确认安全 422，已有采集 409，缺失 SDK/不支持的平台 503，创建录制时磁盘异常 507。**HTTP 200 只表示命令处理完成；客户端仍需检查 `state`、`error` 和 `recording.status`，尤其不能把 stop 返回 200 当作保存成功。**

状态结构：

```typescript
{
  state: 'idle' | 'starting' | 'acquiring' | 'stopping' | 'error',
  error: string | null,
  receiver: {
    source: 'polytec_ivs500' | 'simulation', simulation: object | null, running: boolean,
    deviceIp: string, hostIp: string, dataPort: 60113 | null,
    sampleRate: number | null, channels: ['CH1', 'RSSI1'],
    dllAvailable: boolean, dataLossAssessment: 'unverified' | 'not_applicable_simulation'
  },
  recording: null | {
    id: string, name: string, object: string, turbine: string, point: string,
    samples: number, sampleRate: number | null,
    startedAt: number, endedAt: number | null, sampleOrigin: number | null,
    status: 'incomplete' | 'complete' | 'error', error: string | null,
    unit: 'm/s', rssiUnit: '%', chunks: number,
    overrangeSamples: number, missingRssiSamples: number, unpairedRssiSamples: number
    // additional persistence/integrity metadata may be present
  },
  indexWarning: string | null,
  turntable: { state: 'disconnected' | 'checking' | 'checked' | 'starting' | 'awaiting_feedback' | 'running' | 'stopping' | 'stopped' | 'unknown' | 'error', feedback: object | null, error: string | null },
  turntableBusy: boolean,
  turntableWarning: string | null,
  // only frame / WebSocket includes waveform:
  waveform: {
    sampleRate: number | null, unit: 'm/s', rssiUnit: '%',
    sampleStart: number, sampleStride: 1,
    values: number[], rssi: (number | null)[], overrange: boolean[]
  },
  realtime: {
    available: boolean, sampleRate: number | null, sampleStart: number,
    sampleCount: number, windowSamples: number, frequencySpacingHz: number | null,
    features: { mean: number | null, rms: number | null, peak: number | null,
      peakToPeak: number | null, dominantHz: number | null },
    spectrum: { frequencies: number[], amplitudes: number[] },
    timeDomain: { times: number[], values: number[], unit: 'm/s', representation: string },
    spectrogram: { times: number[], frequencies: number[], db: number[][],
      unit: 'dB re 1 m/s', windowSamples: number, hopSamples: number },
    source: 'polytec_ivs500' | 'simulation', recordingId: string | null,
    computedAt: number, sampleRange: { start: number, end: number },
    quality: { overrangeSamples: number, missingRssiSamples: number, lowReturnSamples: number,
      lowReturnThresholdPercent: 20 }, warnings: string[]
  }
}
```

启用联动时，采集服务先确认转盘静止、无报警，再等待 Polytec 数据采集 ready，随后按 `SET_SPEED → MOTOR_START` 启动连续速度模式。旧固件未返回限位状态时允许连续转动测试，状态和遥测保持 null；已返回的非零限位 flags 仍阻止启动或触发停机。停止时先发送通信停止并确认零速，再关闭采集并完成本地记录。串口超时或停止读回不确定时不会自动重发运动命令；不确定状态写入 `BLADE_DATA_DIR/turntable-state.json`，下一次联动前必须现场核查并通过同一串口/轴显式恢复。普通限位器只用于保护停机，不提供每圈键相或叶片相位同步。

联合记录目录额外包含 `turntable.jsonl`，逐条保存主机观察时间、采样序号、速度/报警/限位/原始位置反馈以及事件；末尾 manifest 保存 SHA-256 摘要。`GET /api/field/recordings/{id}/turntable-export` 可在记录完整保存后导出该文件。联合记录及遥测当前只保存在本机，不自动上传 Web。主机观察时间与 Polytec 采样序号不是硬件同步时间戳，不能用于自动相位校正。

时间字段 `startedAt` / `endedAt` / `sampleOrigin` 都是 **Unix 秒**，不是 JS 毫秒。样本相对时间为 `sample_index / sampleRate`；绝对估计时间为 `sampleOrigin + sample_index / sampleRate`。起点取主机启动 DAQ 的时间，只取一次，不按每批到达时间重置。它不是硬件同步时间戳；采样序号是接收侧顺序计数，不能证明 SDK/UDP 没有丢样。

CH1 是振动速度 `m/s`；RSSI1 是激光回波质量 `%`，不是 CH2。缺失 RSSI 为 `null`，不补零假装有信号；超量程单独传递。设备接口当前不提供 RPM、键相或双振动通道同步；离线恒转速阶次与振型分析使用手动条件，见 [Web 旋转测振说明](../../apps/web/ROTATION_ANALYSIS.md)，不作为自动损伤诊断。显示窗口和 `realtime` 都是局部在线预览，不用于完整录制导出或替代停止后的高频原始分析。

自动点位及按保存顺序执行的联合采集使用到位初段检测器 v5：完成原有两轴到位/停稳检查后，先要求连续 `rssiConfirmMs`（默认 30 ms）低波动窗口，且该区间各窗口的平均 RSSI 极差不超过 `rssiExitSpread`（当前 4 个百分点）。平均值仍漂移时保留满足条件的最近连续区间，不增加固定休眠时间。初段通过后仍按进入 20 ms、离开 30 ms 判断；不再用平均值约束后续进入或离开，也不要求离开回到原背景。断流后重新执行初段检查。`pointCycle.rssiDetector` 和 `handoff` 保存版本、平均值阈值、漂移重置次数及初段通过样本位置。两端使用同一采集服务源码；Windows 安装包需重新构建服务，旧二进制不会随源码修改自动更新。v4 行为保留于检测器未启用 `require_stable_entry_mean` 的路径，可用于离线对照。

`realtime.timeDomain.times` 和 `spectrogram.times` 都是采集起点后的秒数；`sampleRange.end` 不包含末端。`computedAt` 为计算完成的 Unix 秒，允许图形比接收显示窗口最多晚约 250 ms。FFT 对连续原始样本去局部均值并用 Hann 窗，幅值为单边 `m/s`；STFT 窗长最多 256、重叠 75%，`db[频率索引][时间索引]` 固定参考 `1 m/s`，不按每帧最大值归一化。只有时域显示用 min/max 压缩，FFT 和 STFT 不使用显示包络。低回波计数定义为 RSSI < 20%，不作为结构损伤结论。

## macOS 与 Windows 模拟调试

开始示例：

```json
{"source":"simulation","name":"叶片模拟采集","simulation":{"point":"P1","scenario":"baseline"}}
```

`point` 为 P1/P2/P3，源采样率分别约 1000、833.333333、1250 Hz。每约 50 ms 推进一批，使用连续样本序号和 monotonic 时钟定速，10 秒数据循环回放；停止事件立即打断等待，正常保存后可以重新开始一个独立记录。循环边界两侧共 16 ms 用余弦桥接避免人为拼接冲击，此处理记录在来源中，原始压缩 fixture 不变。

| 场景 | 含义 |
|---|---|
| `baseline` | 源工作簿回放，保留原有速度/回波特征；不声称正常实测 |
| `imbalance` | 人工放大振动并增加 20 Hz 转频分量 |
| `impact` | 人工增加每 1.3 秒一次的衰减冲击 |
| `low_return` | 人工降低 RSSI；速度保持源回放信号 |

源文件为用户提供的 `rotation_from_static.xlsx`，SHA-256 `80ec5277f3ae28bf8ec76175c5d172e1ed586d97a0750610d7aca856a571cc50`。参考脚本 `generate-rotation-from-static.mjs` 由 18 Hz 静态波形合成 1200 rpm、3 叶片转动及回波门控，未提供真实损伤标签。`LOW_RETURN` 只是低回波状态。附加场景属于可重复的软件测试注入；记录、帧和 CSV 都保留 `source: simulation` 及完整 `simulation` 来源对象。

精简压缩资源位于 `blade_acquisition/resources/rotation_from_static.json.gz`，PyInstaller 配置会将它打包到服务资源中。可用标准库转换器从原 XLSX 再生成（输出须不存在）：

```bash
python tools/convert_simulation_fixture.py /path/rotation_from_static.xlsx /path/generate-rotation-from-static.mjs /tmp/rotation_from_static.json.gz
```

转换器只读取文件，不执行外部脚本，不修改工作簿；记录原文件与脚本 SHA-256。模拟 binary 的 `raw` 字段使用速度 × 1000000、RSSI × 1000 的整数编码，来源明确标明它不是设备 ADC 原始计数；速度 `float64 m/s` 完整保存。

Web 分析用 CSV 第一行为 `# BladeVMS ` 加单行 JSON（含 `format: blade-vms-csv-1`、source、simulation、sampleRate、unit、samples、recordingId、name、point、position、rpm），第二行为 `time_s,velocity_m_s,RSSI_percent,overrange`。后续每行对应一个原始样本；缺 RSSI 留空。下载器应先写临时文件，仅完整成功后发布，导入器应核对 `samples`，并始终保留模拟标记。

## 本地文件与恢复

每次采集目录由服务生成 UUID，不接受客户端文件路径：

```text
BLADE_DATA_DIR/recordings/
  recordings.sqlite3             # 可重建的元数据索引
  <recording-id>/
    manifest.json                # 原子替换的状态/计数/单位/时间来源
    chunk-00000000.bin            # 已关闭并 fsync 的原始分块
    chunk-00000001.bin.part       # 正在写入或中断时留下的分块
    unpaired-rssi.bin             # 仅 SDK 返回多余未配对 RSSI 时存在
```

分块约 262144 样本后在批次边界切换。每个批次先写原始文件，再更新显示缓存；至少每秒及切块/正常停止时 `fsync` 并提交 manifest。突然断电可能损失最后一次 fsync 之后的数据，因此不能宣称断电零损失。每样本 29 字节（另加 32 字节/块头），218750 Hz 下基础原始数据约 **6.34 MB/s、22.84 GB/小时**，未计文件系统开销；现场须预留足够磁盘空间并做持续采集压测。

二进制小端格式：块头 `<8sddQ>` = `BLADEV01`、采样率、统一 epoch 起点、块首样本序号；样本 `<QidifB>` = 样本序号、速度 int32 原始值、速度 float64 m/s、RSSI int32 原始值、RSSI float32 %、标志（bit0 超量程，bit1 RSSI存在）。多余未配对 RSSI 不虚构匹配关系，另存为重复的 `<QQ>`（源批次起点、数量）+ 数量个 `<if>`（raw、%），并记入计数。

manifest 初始为 `incomplete`，只在正常停止并成功持久化后为 `complete`；任何采集/关激光失败为 `error`。启动会扫描中断记录，按完整二进制记录恢复可读取样本数，保留 `incomplete` 和残余字节说明，不删除尾部原始字节或冒充完整记录。损坏 SQLite 会保留为 `recordings-corrupt-*.sqlite3` 并从 manifest 重建；不会覆盖原始录制文件。状态 `complete` 表示本服务正常收尾，不是设备传输完整性认证。

离线转 CSV（标准库、逐块流式，默认拒绝覆盖）：

```powershell
python export_csv.py "C:\Users\Operator\AppData\Roaming\BladeVMS\field-data\recordings\<id>" "D:\Exports\capture.csv"
```

导出列与同事样例保持一致：`sample,time_s,velocity_raw,velocity_m_s,overrange,rssi_raw,rssi_percent`。`time_s` 为相对采集起点的秒数。中断记录必须先重启服务完成恢复；导出的部分数据不代表完整采集；非预期错误会保留部分 CSV 供检查。额外未配对 RSSI 保留在诊断原始文件中，不伪装成速度样本 CSV 行。

## Windows x64 打包

开发人员在 Windows x64、Python 3.12+ 环境执行（不在终端用户机器要求执行）：

```powershell
# 仅服务，SDK 由已安装的厂商软件提供，联调时配置绝对 DLL 路径
.\build-windows.ps1 -Python "C:\Python312\python.exe" -StageDesktop

# 仅当确认厂商允许重分发时，显式提供包含 DeviceCommunication.dll 及依赖的目录
.\build-windows.ps1 -Python "C:\Python312\python.exe" -SdkDirectory "C:\VendorSDK\x64" -StageDesktop
```

输出 `dist/BladeAcquisition/BladeAcquisition.exe` 和整个 onedir 依赖目录；`-StageDesktop` 复制到 `apps/desktop/resources/acquisition`。不能只复制单个 exe。若提供 SDK，复制的 DLL 位于 `vendor` 子目录，桌面主进程应指向其中 `DeviceCommunication.dll`。脚本不下载或安装厂商驱动，不修改设备，不启动真实采集。

打包后再由 Electron 的 Windows 打包流程把整个服务目录作为资源打入统一安装包。厂商首次安装依赖、签名、Windows 防火墙和真正设备性能/关机行为仍待实机联调；本次 macOS 验证不能代替 Windows 生成二进制及设备验证。PyInstaller 需在目标平台构建，[官方说明](https://pyinstaller.org/en/stable/operating-mode.html)。

依赖直接版本根据项目自己的 PyPI 发布页核验，并在隔离 Python 3.12 环境实际安装后冻结运行时传递依赖：[FastAPI](https://pypi.org/project/fastapi/0.137.2/)、[Uvicorn](https://pypi.org/project/uvicorn/0.52.4/)、[websockets](https://pypi.org/project/websockets/15.0.1/)、[PyInstaller](https://pypi.org/project/pyinstaller/6.22.2/)。脚本输出完整的 `build-dependencies.txt`；测试辅助依赖 httpx 有 Starlette 弃用提示，不影响当前测试通过，未把测试服务器放进产品采集路径。

## 六组预存点位与采集联动

协议依据厂商 `lazer_check` 提交 `2ec1b1b`（v3.9.4）。Mac、Windows 共用本服务；本项目只适配接口，不修改或烧录固件。

自动跟随中，一个径向测点（例如 P3）的整圈位置占用一组，最多 16 个位置。圆周间隔 180°／90°／60°／45°／30°／22.5° 分别生成 2／4／6／8／12／16 个位置，不额外上传重复的闭合点；作业原点单独处理。控制器同时保留六组，本服务按测点选用时上传、按最近使用顺序复用空间，超过六组时替换最久未使用的一组，不限制本地任务/历史记录数量。

1. “移动到预设位置”校验全组坐标和参考位，用 `0x40/0x41/0x42` 预存并准备，再用 `0x43` 定位首点；预存本身不运动、不采集。
2. “开始采集”重读组状态、令牌和参考位，并核验实际位置。预存仍有效就复用，已到首点就不再次发运动指令；没有预定位则先完成上述准备。
3. 叶片进入、离开确认后，`0x43` 只发送组号、令牌和点号。移动期间保持现有连续接收与原始记录策略，关闭叶片判断，确认到位后再开启判断；记录继续按任务、叶片、径向测点、圆周点位、圈数归档。
4. 正常完成后，通过 `0x1A` 返回配置的作业原点，不占第 17 个点位。它不是 `0x43` 失败后的重试或降级路径。

转速和到位容差在预存时确定，按编号移动不重复发送。暂沿用平台转速上限（按 0.01 rpm 向下量化）和 0.5° 到位容差；驱动加减速继续由 PA40/41/42 控制。更新速度、坐标、参考位或掉电后，下次准备重新校验/上传。新 SDK 不传速度时使用其 SDK 默认值，线上的预存报文仍需要速度字段。

到位使用新鲜 `0x37` 双轴反馈：实际误差、零速、无故障/活动任务及控制器完成标志；没有完成标志时需两次独立停止反馈。缓存零速不能直接开启叶片判断。未知命令才允许继续旧定位流程；超时不自动重发运动。旧四组固件访问第 5、6 组时提示升级，不覆盖其他组冒充成功。

`tests/test_preloaded_points.py` 覆盖六组复用、容量、重复预定位、按编号换点、两圈保存、返原点、旧固件及未知执行结果。离线通过不代表实机响应时间或 Windows 安装包已验收。

## 不接硬件的验证

```powershell
python -m pip install -r requirements-build.txt
python -m unittest discover -s tests -v
```

测试使用明确的 fake receiver/SDK 和临时目录，覆盖鉴权、Origin/Host、激光确认、缺 DLL、HTTP 真实进程启动闲置、WS 协议、采集/停止、5000 原始点与 2048 显示点、磁盘/fsync 失败、激光超时与错误关断、SQLite 修复、分块和未完成恢复、CSV 导出拒绝覆盖、未配对 RSSI 保留。它们不运行真实 SDK、不连接设备、不证明 UDP 无丢包或 218.75 kHz 持续采集性能。

到位初段候选核对：`entry_evidence.py` 在既有 20 ms 进入窗口内，观察平均 RSSI 相对最近低波动窗口的变化，及速度 RMS 相对最近最多 10 个低波动窗口 P90 的变化。速度佐证为 RMS 达到噪声的 3 倍（最低 1 µm/s）；这些只是信号特征，并非叶片身份或物理经过的证明。`entryEvidenceMode=observe` 仅记录，`required` 保留原实验规则（均值变化或速度增强二者满足其一），均可显式用于诊断对照。当前默认 `arrival_guard` 的有限拦截范围见下文 v8。断流及新点位清空特征，不额外增加固定等待，也不改变离开 30 ms 和停稳检查。原始速度信号用于核对，不对本机全量数据降采样。

移动期间接收的数据仍归档到连续原始记录，但判定入口关闭。只有到位/停稳与 SDK 缓存边界确认后，新的点位检测器才接收边界后的数据；移动期间的进入/离开状态不传给下一点。此保证覆盖客户端已收到及 SDK 已排空的数据，不覆盖设备/网络仍在途且没有设备采样时间戳的旧包；`deviceNetworkFreshness=unverified` 不能解释为设备端新鲜度已证实。参见 `artifacts/arrival-edge-audit-20261023/verified.json` 的离线对照和限制。

### 移动期间关闭激光的客户端试测策略

当前 Mac / Windows 共用采集路线使用 `motionLaserPolicy=continuous`（移动常亮）。诊断调用可显式发送 `motionLaserPolicy=off_during_motion`：首次定位、自动换点、正常结束回原点均先确认关灯，再运动，到位停稳后确认开灯。持续接收器由原 SDK 线程执行开关与回读，移动和开关期间的样本不进入叶片判定；到位后沿用初段扰动过滤以及进入/离开确认，不增加固定延时。原始连续记录保留暗场与移动数据。

这是一项待现场观察的对比策略，不能视为已经消除误触发。正常结束回原点后保持激光开启；停止/异常沿用现有处理。独立的“移动到预设位置”仍仅定位、不切换激光。旧客户端未传新字段时继续常亮，便于保留对照。

### 到位初段进入资格复核（v7）

初段低波动通过后，进入确认前继续检查最近同长度窗口的回波均值。均值再次漂移超过离开阈值，或未达到20 ms的进入候选中断时，撤销旧资格，重新从当前信号获得30 ms低波动且均值稳定的区间，再等待新的进入。干净进入不新增等待；已经确认进入后仍按原30 ms离开规则。无固定延时、无速度幅值硬门槛，移动阶段仍关闭判定门。动作日志记录撤销原因。

### 初段可疑候选联合判断（v8，实机验证待恢复连接）

自动跟随及已保存点位联动默认 `arrival_guard`。范围限定为：本点到位后已经出现高回波波动、均值漂移、资格撤销或断流，随后重新确认平静，进入起点距这次资格确认不超过一个实际回波窗口（默认 10 ms）。这种候选必须同时满足原回波进入 20 ms，以及同一候选期间的有效速度 RMS 增强；回波均值跳变不能单独放行。无到位扰动或资格通过更久才出现的候选仍按原规则判定，不能理解为所有经过均已通过联合佐证。

候选失败记录 `arrival_evidence_rejected`、原因和完整证据，清除当前进入候选并重新识别平静→进入前沿，不将同一段持续高波动反复尝试放行。合格候选仍在原 20 ms 时刻确认，离开仍为 30 ms，无新增固定睡眠；拒绝候选可能导致等待下一次叶片经过，需在实机中单独统计漏检/等待代价。超量程或无效速度不能为高风险候选放行。

记录携带 `detectorVersion=8`、`arrivalEvidenceRejections`，以及证据中的 `arrivalCandidateGuarded`、`entryAfterClearMs`、`jointSupported`。软件测试覆盖干净弱信号不被全局拦截、异常初段拒绝、强信号零新增采样等待、断流、分批和稀疏 RSSI，以及 Mac/Windows SDK 分支。用户暂停连接后尚未进行 v8 实机测试，不宣称已降低物理误触发率。

### 异步落盘与控制锁隔离

写盘线程的批次进度发布采用非阻塞控制锁：控制线程忙时仅延后内存清单进度更新，继续排空原始数据队列。最终落盘、fsync 和清单发布仍须全部完成，才能报告记录完成；不丢弃已接受数据，不取消队列满和磁盘错误保护。

每条新记录的 `writerDiagnostics` 保留队列容量/峰值、延后发布次数、最大写批次耗时、最大显式持久化耗时及接受/写入样本数。写批次耗时包括该调用中可能发生的换块和持久化；接受数与写入数相等只证明软件接收后的保存一致，不证明设备或网络无丢包。

2026-10-23 控制锁占用回归用例在修复前阻塞、修复后通过。Mac 三点单圈实测连续原始记录保存 2,220,750 样本，队列峰值 6/32、延后发布 10 次，完整收尾。该实测不证明所有存储压力下都不会队列满，也不替代 Windows 实机验收。

### 250 kHz 写盘瞬态缓冲（2026-10-23）

P4 实测单点记录的显式保存耗时约 356 ms，32 批命令队列耗尽；磁盘仍有约 781 GiB 可用。现改为 NumPy 按原 BLADEV01 小端无对齐格式批量打包，保留全部原始值、稀疏 RSSI 标志、未配对 RSSI 与最终 fsync。共享 Python 服务同时用于 Mac 和 Windows。

队列默认同时受 512 条命令、500000 个待写样本约束（包含正在写入的批次）。250 kHz 下样本上限对应约 2 秒的瞬态积压，不是新增采集等待，也不能解决持续慢盘。超过任一上限仍停止采集，已接受数据尽力排空，记录标记异常；不以丢弃原始数据换取继续运行。`writerDiagnostics` 新增样本容量/峰值，`storageDiagnostics` 分别统计打包、文件写入、同步、清单和索引耗时峰值。

回归测试覆盖二进制逐字节兼容、稀疏/缺失/多余 RSSI、积压超过旧 32 批限制后完整排空、样本预算耗尽与磁盘故障仍停止。压力回放与实机采集分开验收。

### 未停稳判定诊断开关

自动跟随提供默认关闭的 `diagnosticDetectBeforeSettled`。开启后，仅在连续采集与激光常亮模式中，收到双轴内部定位有效反馈后即开启独立的原始流观察器，按 `diagnosticAngleWindowDeg` 判断是否进入目标角度范围（0为不限制，0～10°，界面提供±0.5/1/2/3/5/10°及不限制；仅控制诊断判断时机，不修改运动速度、跟随保护或到位容差），不等待停止确认，跳过初段平静/均值/联合证据过滤；进入、离开确认时间仍取配置（现场20/30 ms）。首次开放以 SDK 缓冲边界隔离旧样本；超出已配置角度范围、反馈无效、存在轴故障或移动反馈超过500 ms未更新会重置观察器。途中经过也可能触发，不能把该诊断结果当作目标点的有效叶片数据。

观察器只判定、不会发送运动指令。完整经过可以在停稳前被记住；仍由原有运动执行器完成故障/参考位/停止检查，之后才允许下一点运动，不覆盖正在执行的命令。经过跨越停止时刻时保留同一检测状态。远离目标的途中叶片仍不参与判定；回作业原点不启用观察器。

记录使用 `diagnosticOnly=true`、`validMeasurement=false`、`completion=diagnostic_pass` 标注，任务名带“未停稳判定测试”；进入离开索引属于关联的连续原始记录，不伪装成停稳后点位记录的索引，也不进入正常有效叶片片段拼接。关闭开关恢复既有停稳后判定流程。Mac/Windows SDK路径的集成测试验证提前经过被保留、无重复运动、无第二片叶片也能完成流程；物理误触发率和节省时间仍需现场复测。

已在移动期间完成的诊断经过采用快速换点路径：当前运动停止确认及位置/参考核验后，直接消费已记住的事件；不新建单点文件、不再次请求 SDK 边界、不等待新的静止数据包。仍由同一个运动线程顺序执行下一点，不允许重叠下发。没有提前事件时继续使用原采集路径。

快速路径在连续原始记录的 `diagnosticBookmarks` 保存任务、叶片、测点、圈数及全局样本区间，单点文件延迟至整轮连续记录收尾后生成。区间从进入样本（向前对齐 RSSI 采样间隔）到离开确认样本，复制真实速度、回波和量程标记，局部索引从0开始；`handoff` 内仍明确使用连续流全局索引。没有额外合成静止数据，也不会将运动期诊断数据标为有效测量。记录生成期间仍属任务收尾，全部写盘成功后才显示完成；异常、取消、原始区间损坏或复制失败均不会误报成功。原始记录和书签保留以便核查，进程意外退出时未生成的单点文件不会被宣称已保存。

日志增加 `early_handoff_ready`、`recordPreparationDeferred` 和 `recordMaterializedAt`，可分别比较原始检测、停止确认、下一条命令下发及单点文件生成时间。详见 `docs/early-handoff-20261024.md`。该路径不修改下位机协议、速度、加速度、到位容差或20/30 ms判定参数。
