# Windows 现场采集联调

## 当前源码开发入口（2026-09-22）

本地启动、Mac 显式模拟采集、实时采集/分析标签及完整原始数据导出见 [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)。当前源码将完整旋转测振移至 Web，支持导入 XLSX / CSV / CSV.gz；模拟数据会保留来源，不因缺设备而自动回退。**本次未重新生成 Windows 安装包，也未验收物理设备。** 下方保留既有 Windows 打包说明与 1.1.0 历史记录，旧版“无模拟源”“壳包”等措辞不描述当前本地源码。

## 桌面端 1.2.0 完整安装包

当前打包流程已要求内置 Windows x64 Python 运行时、采集服务、Polytec DLL、SDK 许可/源码以及经过微软签名校验的 VC++ x64 安装程序。缺少这些内容时打包失败。子进程使用绝对路径和独立环境，不调用系统 Python，不继承 Python/Conda 的搜索路径；不修改系统 PATH 或 Python 文件关联。

安装与现场检查请阅读 [WINDOWS_TEST_GUIDE.md](WINDOWS_TEST_GUIDE.md)。Windows CI 执行 DLL 加载/18 个符号绑定自检、闲置 HTTP/WS 检查、安装/登录/改密/退出、已有 Python 环境共存检查。软件侧测试不发起真实设备连接或激光操作；实际数据、吞吐和丢样仍待现场验收。具体通过结果以本次 CI 报告为准。

下文保留 1.1.0 接入版本的实现说明与历史验证。关于“手动选择服务/不含 Python 的壳包”的描述仅适用于旧版，不是 1.2.0 的交付步骤。

## 1.1.0 历史接入记录

## 本次变化与边界

- EXE 使用独立真实现场工作台，不提供离线演示登录、自动模拟源或虚构双通道。
- 保留无网工作：本机 admin 登录、设备采集、SQLite 元数据索引、原始分块文件与历史预览不依赖 Web/MySQL。
- Electron 托管 Python 本地进程，不注册为开机常驻 Windows 服务。HTTP/WS 仅监听回环地址；每次启动生成随机会话令牌，令牌不进入渲染页面。
- 非 Windows 开发机（macOS/Linux）同样由 Electron 托管启动采集服务，改用仓库内 `services/acquisition/.venv` 的 `python -m blade_acquisition`（可用 `BLADE_ACQUISITION_PYTHON` 覆盖解释器路径）。厂商 SDK 仅 Windows 可用，因此开发机可浏览记录、波形与分析，不能连接真实设备；子进程环境同样剔除 Python/Conda 变量，避免模块解析被外部环境污染。
- 服务启动后闲置。只有完成安全确认并点击开始才修改设备 DAQ 目标 IP、开启激光并采集。停止时尝试关闭本次会话控制的激光；异常应现场确认设备状态。
- 基于同事 `damage_detection` 的 IVS-500 SDK 接入代码，厂商 DLL/驱动没有随源码发布。未在此 Mac 环境连接真实设备、验证吞吐量或验证 Windows 安装行为。
- 本版 Windows 壳安装包可以登录和检查缺失依赖；它尚不包含已在 Windows 构建的 Python 服务。完整“一次安装”交付需按下文加入 Windows 服务包后重新打包。

## 本机账号

- 用户名：`admin`。初始随机密码单独交付，不写入源码或本文；包内只有 scrypt 盐值与哈希。
- 首次登录必须修改初始密码（12–128 字符），随后才允许采集和设置服务。
- 本机账号与 Web 管理端账号独立；本次不修改 Web 的账号或密码。每个 Windows 用户目录有自己的本机凭证。
- 凭证文件损坏时拒绝登录，不自动重置初始密码；退出软件不保存登录态。五次密码错误暂锁 60 秒。
- 这是本机工作区访问控制，不替代 Windows 用户权限、磁盘加密或多租户权限隔离。

## Windows 联调步骤

1. 使用 Windows x64 实机（不以 PD/ARM 虚拟机作为本次验收目标），安装桌面 1.1.0，或完整解压 ZIP 后打开 BladeVMS.exe。
2. 用本机 admin 和单独交付的初始密码登录，完成改密。
3. 按厂商要求安装已取得的设备软件/驱动/运行库。确认设备 DLL 为 x64，保留其完整依赖目录。
4. 构建下述适配后的 Python 服务，或取得同事基于本目录接口构建的完整服务包。旧 `damage_detection` 的服务不能直接视为此版本协议兼容。
5. 在客户端“服务设置”中选择 `BladeAcquisition.exe`，再选择 `DeviceCommunication.dll`。服务必须显示就绪，但此时不应开始采集或开启激光。
6. 将设备网线接入电脑，配置实际网卡地址。表单填写设备 IP、本机有线网卡 IP 和任务元数据；不要把本机回环地址作为设备数据接收地址。
7. 确认激光安全、设备目标 IP 变更及采集操作后开始。观察真实状态、CH1 速度（m/s）、RSSI（%）及超量程；没有第二路振动测量时不显示假 CH2。
8. 停止并确认记录为 complete，再打开数据目录/历史预览；检查长时间数据完整性和设备激光状态。

设备网络、防火墙规则、厂商驱动需在目标机器按实际端口配置；不要关闭整机防火墙或防护软件。本机服务的随机 HTTP/WS 端口仅绑定 127.0.0.1，无需对局域网开放。

## 构建 Python 服务和统一安装包

在 Windows x64 开发机准备 Python 3.12+，进入仓库根目录执行：

```powershell
# 只打包服务：保留输出目录中的所有文件，不能只拷贝EXE
.\services\acquisition\build-windows.ps1

# 将服务暂存进Electron资源目录，下一次打包即可随客户端交付
.\services\acquisition\build-windows.ps1 -StageDesktop

# 如果已确认允许分发这些厂商DLL，可显式提供其目录
.\services\acquisition\build-windows.ps1 -SdkDirectory "C:\VendorSDK\x64" -StageDesktop

npm ci
npm run package:windows
```

完整服务输出为 `services/acquisition/dist/BladeAcquisition/`；统一包资源目录为 `apps/desktop/resources/acquisition/`。如果通过设置选择外部服务，则保留该目录，不要移动/删除其依赖。修改服务或 DLL 路径会重启闲置服务，但不会自动开始设备采集。

客户端输出：`apps/desktop/release/BladeVMS-Setup-1.1.0-x64.exe`（安装程序）和 `BladeVMS-1.1.0-win.zip`（完整便携目录压缩包）。未签名；正式交付前由团队完成代码签名及目标环境安全审核。

## 原始数据和异常恢复

- 原始数据保存在当前 Windows 用户应用数据目录的 `BladeVMS/field-data/recordings/`（开发环境目录名可能不同）。以客户端“打开数据目录”的实际位置为准。
- 每次采集有独立目录、`manifest.json`、分块二进制数据；`recordings.sqlite3` 是可重建索引。原始数据在推送显示之前写入，界面最多显示有限窗口，不能把该窗口作为完整采集导出。
- 记录状态为 `complete`、`incomplete` 或 `error`。完整只表示本机采集程序正常收尾，不等于已经证明设备 UDP 无丢包；`dataLossAssessment` 保持 unverified。
- 采样时间采用会话统一主机时间起点 + 采样序号 / SDK 采样率，不把每批到达时间当硬件时间戳。转速、键相、第二路振动同步、健康/模态/损伤算法不在本次接入实现范围。
- 强制退出、断电或 SDK 异常后的未完成数据保留，并在重启时标记检查。磁盘写入失败会报错停止，不能保证物理断电前尚未刷盘的数据不丢失。
- 旧版 `blade-offline.json` 不删除、不覆盖、不自动混入真实采集记录。Web 与旧业务页面代码仍保留，但本版 EXE 不再加载演示采集/演示算法；真实原始分块与 Web 的同步接口仍待后续衔接，不宣称已经全量回传。

## 验收清单

- 断网情况下首次登录/改密/重新登录；密码错误、重启后旧密码失效。
- 未安装服务、缺 DLL、DLL 位数不匹配时明确报错，无模拟数据和自动激光操作。
- 正常采集、停止、历史预览，确认样本数、单位、RSSI、超量程及原始分块可读。
- 拔网线、设备掉电、SDK 异常、磁盘空间不足、软件退出时的状态与未完成数据保留。
- 目标采样率与持续时长的吞吐量、设备丢样判据、长时间文件容量与磁盘占用实测。

服务契约、数据格式、Python 测试和离线 CSV 转换见 [services/acquisition/README.md](services/acquisition/README.md)。

## 本地验证记录

2026-09-09 在 macOS 完成：本机认证 11 项、进程/传输 14 项、界面静态/纯函数 13 项、Python 服务 20 项测试；原生 Electron 登录/改密/缺服务/登出 6 组烟测；实际 Python 子进程与 Electron 管理模块的 HTTP/WS 闲置启动契约检查；TypeScript 与桌面生产构建通过。所有设备输入测试使用独立 fake SDK/临时数据，未连接设备。生产包不含测试或模拟源。

```bash
npm run test:field
npm run typecheck
npm run test:field-desktop
# 先准备 services/acquisition/.venv 或通过环境变量指定测试 Python
node scripts/test-field-contract.cjs
```

截图与运行回执位于本地忽略目录 `artifacts/field-desktop-smoke/`；它们是软件验证证据，不能替代 Windows 实机及现场设备验收。
