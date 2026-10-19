# Mac 原生测振 SDK

Windows 的 `DeviceCommunication.dll` 不能由 macOS 原生加载。项目提供的 Polytec SDK 包含完整 C++ 源码，可在 Apple Silicon 上重新编译成 `libDeviceCommunication.dylib`，由采集服务动态加载。

[构建工具](../scripts/polytec-macos/README.md)接受外部 SDK 路径，默认产物放在忽略目录 `apps/desktop/resources/acquisition/vendor`。原始厂商文件不变，不会自动安装依赖或访问设备；产物附带许可、源码引用、原始源码压缩包、修改补丁和复现材料。

截至 2026-10-19，本地 arm64 构建、71 个 C API 导出及无设备 payload 往返测试已通过。这是项目的本地兼容实现，不等于厂商正式提供或认证了 Mac 支持。真实采集、激光、转盘及数据同步需分别记录现场验证结果；不能仅凭库加载成功认定完整流程可用。

## 本次设备验证记录

- 通过 Mac 原生 SDK 读取 `192.168.106.90` 的真实配置成功：VFX-F-110，速度量程 1 m/s、带宽 20 kHz、激光关闭。读取不会改变设备配置。
- 原生库已放入本机客户端资源目录；下次启动客户端会自动识别，也可在“设备与服务 → 选择设备 SDK”手动选择 `.dylib`。
- Mac 转盘串口支持 `/dev/cu.*`，保留路径大小写，仍要求有效参考位、限位及运动前确认。
- VFX 的速度采样率与 RSSI 基率分别记录；原始 RSSI 按实际时刻保存，空位不补值。图表可显示孤立真实采样点。
- 重新接线后，通过新版桌面实际采集 5.76 秒：250,000 Hz、1,440,000 个连续样本、6 个完整分块，VFX 协议4 / TCP；停止后独立读取确认激光关闭。原始记录、量程换算及原生导入校验均通过，0 超量程、0 RSSI 缺失。
- 真实记录 ID：`bfff6979794b4b66a0d2f86c0abdd5b7`。验证报告：`artifacts/mac-device-check-20261019/real-record-validation.json`。此结果确认数据链路与文件完整性，不代表完成测量质量校准。
- 随后通过桌面执行轴1真实 0.1°往返：`10.037° → 10.137° → 10.037°`，原始计数 `−21736 → −21597 → −21736`；轴2始终为 `−1.162°`、计数 `388`。最终两轴速度和故障码均为0、停止待确认为否，软限位开启。去程文本与回程截图见 `artifacts/mac-device-check-20261019/turntable-forward.txt`、`turntable-return.png`。
- 回程中曾出现一次 USB 串口 `ENXIO` 失败，先执行停止并确认停稳，再重试成功回到原计数。此结果只证明本次往返及异常恢复，**不能判为通信稳定通过**。
- 用户确认转盘串口与设备以太网接在同一个 Hub，本轮尚未分离或重接验证。Hub、供电或 USB 链路可作为排查方向，尚不能认定 Hub 为唯一根因。

截至本轮报告，115 的转盘/RSSI 兼容版本 `/opt/bladevms/releases/20261019-mac-vfx-capture-compat` 已激活。健康接口及数据库正常、8个采集接口未登录请求均返回401、20个发布源文件哈希核对通过。发布证据见 `artifacts/capture-compat-20261019/evidence/release-complete.json`、`active-release-verification.json` 和 `public-api-verification.json`；这些是部署、文件一致性与未登录鉴权检查，**不代表真实联合采集验收通过**。

用户明确暂时断开设备、待会再测，硬件测试已暂停；尚未验证改变单 Hub 现有接法后的效果。本机已安全退出并重启客户端，停在登录页。真实转盘与激光**联合采集**、真实记录自动上传至115及 Web 实时波形均尚未验收，不能用此前独立采集与独立往返代替。用户恢复测试后再核实接线、登录、Web 绑定与自动同步，记录同一次联合任务的本机原始记录、转盘遥测、云端实时变化及完整上传校验。

本次分项状态与证据索引见 [`acceptance-status.json`](../artifacts/mac-device-check-20261019/acceptance-status.json)。
