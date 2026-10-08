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
| `POST /api/field/start` | JSON：`deviceIp`、`hostIp`、`name`、`object`、`turbine`、`point`、`confirmLaser: true`；返回状态；真正启动在后台进行 |
| `POST /api/field/stop` | 无必需请求体；等待停止、关激光和本地数据收尾，最长约 20 秒；返回最终状态 |
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

时间字段 `startedAt` / `endedAt` / `sampleOrigin` 都是 **Unix 秒**，不是 JS 毫秒。样本相对时间为 `sample_index / sampleRate`；绝对估计时间为 `sampleOrigin + sample_index / sampleRate`。起点取主机启动 DAQ 的时间，只取一次，不按每批到达时间重置。它不是硬件同步时间戳；采样序号是接收侧顺序计数，不能证明 SDK/UDP 没有丢样。

CH1 是振动速度 `m/s`；RSSI1 是激光回波质量 `%`，不是 CH2。缺失 RSSI 为 `null`，不补零假装有信号；超量程单独传递。设备接口当前不提供 RPM、键相或双振动通道同步；离线恒转速阶次与振型分析使用手动条件，见 [Web 旋转测振说明](../../apps/web/ROTATION_ANALYSIS.md)，不作为自动损伤诊断。显示窗口和 `realtime` 都是局部在线预览，不用于完整录制导出或替代停止后的高频原始分析。

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

## 不接硬件的验证

```powershell
python -m pip install -r requirements-build.txt
python -m unittest discover -s tests -v
```

测试使用明确的 fake receiver/SDK 和临时目录，覆盖鉴权、Origin/Host、激光确认、缺 DLL、HTTP 真实进程启动闲置、WS 协议、采集/停止、5000 原始点与 2048 显示点、磁盘/fsync 失败、激光超时与错误关断、SQLite 修复、分块和未完成恢复、CSV 导出拒绝覆盖、未配对 RSSI 保留。它们不运行真实 SDK、不连接设备、不证明 UDP 无丢包或 218.75 kHz 持续采集性能。
