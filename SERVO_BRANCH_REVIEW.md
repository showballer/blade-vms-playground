# 转盘联动分支审查与合并记录

审查日期：2026-10-19。源码路径均相对本仓库根目录，行号按本次审查时的工作区标注；功能基线为 `a29f9cdf44eb471b6731c53a84616a1011bd1422`。

## 分支与本轮范围

远程分支：`origin/feature/servo-turntable-integration`。相对原 `main` 基线 `aad5632` 新增两次提交：

| 提交 | 日期 | 主要内容 |
| --- | --- | --- |
| `b85aefdeca062f5e3f4add69f13996b1571a1510` | 2026-10-15 | 转盘驱动、采集前检查、独立试转和联合采集 |
| `a29f9cdf44eb471b6731c53a84616a1011bd1422` | 2026-10-18 | 共享点位库、点位回位、多点循环、RSSI 进入/离开换点和流程日志 |

该分支共修改 **39 个文件，新增约 5,391 行、删除约 65 行**。功能面向桌面端及其本机采集服务，未修改 `apps/web`。具体涉及：

- 桌面 React 界面、状态类型和样式。
- Electron 主进程、服务桥接、导出和云同步保护。
- Python 采集服务、串口协议驱动、RSSI 判定和激光生命周期。
- Windows 服务打包依赖、pyserial 许可证、测试脚本和操作文档。

桌面包声明版本由 `1.5.0` 改为 `1.5.1`；版本号变化不代表已经发布新安装包。

**本地 `main` 已快进合并至 `a29f9cd`。第一阶段完成桌面 UI Token 整理；用户随后授权修复转盘上传、多点同步、点位参考信息，并在验证通过后提交推送至 `main`。** 本次包含这三项修复及此前 UI 调整，不部署服务器或发布 Windows 安装包。本机账号配置不纳入提交。

## 桌面功能变化表

| 功能区域 | 新增或变化的功能 | 主要源码 |
| --- | --- | --- |
| 转盘连接与检查 | 枚举 COM 串口；展示两轴角度、速度、原始计数、报警、参考位和软限位；按轴保留参数草稿 | `packages/ui/src/field-turntable.tsx:166`；`apps/desktop/electron/field-service.cjs:485` |
| 独立试转与定位 | 支持独立限角定位、短时速度试转、停止及停稳确认；轴1限 ±35°、轴2限 ±180°；运动前核查参考与保护状态 | `packages/ui/src/field-turntable.tsx:186`；`services/acquisition/blade_acquisition/turntable.py:231` |
| 联合采集 | 先等待测振仪采集就绪，再发送转盘运动；支持人工或定时停止；真实采集确认增加运动确认；记录转盘反馈与事件 | `packages/ui/src/field-desktop.tsx:149`；`services/acquisition/blade_acquisition/service.py:890` |
| 独立「转盘点位」页 | 单轴微调与定位；读取两轴角度，也允许手工填写记录角度；点位保存、删除、CSV/JSON 导出；一键先轴1再轴2回位 | `packages/ui/src/field-turntable.tsx:333` |
| 自动多点循环 | 使用共享点位库，设置圈数、每点时长与换点速度；范围内规划较短移动路线、两轴并行定位；每点独立保存记录，每圈回到首点 | `packages/ui/src/field-turntable.tsx:256`；`services/acquisition/blade_acquisition/service.py:1428` |
| RSSI 自动换点 | 用 10 ms 窗内 P90−P10 波动先确认进入、再确认离开后换点；可调波动阈值和确认时间；信号异常重置判定，等待超时停止 | `services/acquisition/blade_acquisition/rssi_handoff.py:14`；`packages/ui/src/field-turntable.tsx:260` |
| 叶片跟随流程 | 展示当前阶段、圈数、点位、已存记录数、RSSI、进入/离开确认计时及带时间的动作日志；过程事件随点位记录保存 | `packages/ui/src/field-cycle-progress.tsx:17`；`services/acquisition/blade_acquisition/service.py:1065` |
| 激光控制 | 增加手动观察激光开关；循环点位之间可保持激光开启；采集结束、停止和异常执行关闭流程 | `packages/ui/src/field-device.tsx:8`；`services/acquisition/blade_acquisition/receiver.py:120` |
| 回波标定 | 分别记录背景、叶片停在光斑上、手动拨过叶片三种状态的 RSSI 统计，保存至本机 | `packages/ui/src/field-device.tsx:86`；`services/acquisition/blade_acquisition/service.py:660` |
| 本机记录与导出 | 记录列表新增点位及目标角度；CSV 增加转盘摘要；可单独导出转盘遥测 JSONL | `packages/ui/src/field-desktop.tsx:170`；`apps/desktop/electron/field-main.cjs:100`；`services/acquisition/blade_acquisition/csv_export.py:47` |
| 旧固件兼容 | 当旧固件不支持 DAQ 目标地址属性时尝试 SET，若仍返回同类不支持错误则记录 warning 并继续采集；其他通信错误仍报错 | `services/acquisition/blade_acquisition/receiver.py:131` |
| 打包支持 | 增加 pyserial 3.5、Windows 串口模块打包和对应许可证 | `services/acquisition/requirements.txt:4`；`services/acquisition/BladeAcquisition.spec:9` |

## 三项问题的修复结果

| 问题 | 原分支行为 | 修复后行为 | 主要源码 |
| --- | --- | --- | --- |
| 转盘记录上传 | 完整记录含 `turntable` 时返回 409，转盘遥测无法随原始记录进入 Web | 上传清单包含 `turntable.jsonl`，断线按偏移续传；服务端核对文件摘要、JSONL 结构、事件数及时间顺序；完整记录支持授权下载转盘元信息和遥测，进入分析工作区时保留原文件。循环点位只有角度元信息、没有遥测文件的合法记录也可上传 | `apps/desktop/electron/field-cloud-sync.cjs`、`apps/web/lib/captures.ts`、`packages/ui/src/web-captures.tsx`、`services/acquisition/blade_acquisition/native_capture.py` |
| 多点循环同步 | 仅在用户开始/停止时登记，循环后台创建的中间点位可能漏掉 | 启动前持久化授权会话，每个点位记录携带会话编号；后台扫描并登记每个点位，切换实时活动记录；停止和退出前补齐最后记录；重启恢复、队列背压与写盘失败均保留重试依据，不误登记历史或其他账号的记录 | `apps/desktop/electron/field-capture-tracker.cjs`、`field-main.cjs`、`field-cloud-sync.cjs`、`services/acquisition/blade_acquisition/service.py` |
| 点位参考信息丢失 | 独立点位页与采集页使用不同字段并覆盖同一个共享库，切页可能丢失参考签名与串口 | 两页共用读写与规范化函数，保留旧 `references`、规范 `referenceSignature`、`port` 和额外元信息；UI、Electron、Python 校验串口和参考签名，运动前逐点对比真实反馈 | `packages/ui/src/field-turntable-points.ts`、`field-turntable.tsx`、`apps/desktop/electron/field-service.cjs`、`services/acquisition/blade_acquisition/turntable.py` |

旧点位缺失参考位或串口、或两个签名字段冲突时，仍可查看、导出和删除，但必须重新读取并标定后才能用于回位或自动循环；不会将当前参考坐标静默补到历史点位。点位记录与采集 manifest 同时保留串口和参考签名。

自动同步授权固定到开始采集时的服务器、账号和租户。关闭自动同步只影响后续新采集，已经授权登记的任务继续恢复上传；上传状态不会因为轮询而重置重试间隔。异常或未完整保存的记录留在本机，不会被当成完整原始记录上传。

## 本次测试与验证边界

在 macOS、Python 3.12、本地 Web 与 MySQL 环境验证，无真实串口、测振仪或转盘连接。

| 检查 | 结果与覆盖范围 | 日志 |
| --- | --- | --- |
| 采集服务 Python 全套 | 167/167 通过；包含转盘遥测验证、循环首点及后续点参考变化拒绝 | `artifacts/servo-sync-fix-20261019/python-tests.log` |
| `npm run test:field` | 账号、服务桥接、窗口、桌面展示、共享点位 helper 和 bending 检查通过；点位 helper 6/6 | `artifacts/servo-sync-fix-20261019/field-tests.log` |
| `npm run test:field-cloud-sync` | 15/15 通过；包含转盘清单、摘要、缺失遥测拒绝 | `artifacts/servo-sync-fix-20261019/cloud-sync-tests.log` |
| `npm run test:field-capture-tracker` | 逐点追踪15/15、主进程装配3/3通过：快速点位、1005条记录、离线/重启、账号隔离、关闭自动同步、退避、队列满后恢复、队列写盘失败回滚、停止/退出 flush | `artifacts/servo-sync-fix-20261019/capture-tracker-tests.log` |
| `npm run test:captures` | 44项权限检查与8组采集契约通过，包含遥测授权下载、坏文件拒绝和分析原文件保留 | `artifacts/servo-sync-fix-20261019/capture-tests.log` |
| 本地 HTTP / MySQL / Python 联调 | 实际采集服务、桌面同步队列及 Web API；3个模拟点位实时波形与2049频点 FFT、完整文件校验、断线恢复、上传成功但响应丢失后的偏移续传、角色隔离、离线导入及3点旋转分析均通过；遥测下载及分析工作区文件摘要一致 | `artifacts/servo-sync-fix-20261019/capture-flow-e2e.log`、`artifacts/capture-flow-e2e/report.json` |
| 实际桌面主进程装配联调 | 本机登录、统一账号绑定、IPC模拟采集、实时FFT、停止及原始文件上传全流程通过；仅 Electron 窗口为替身 | `artifacts/servo-sync-fix-20261019/field-main-e2e.log` |
| Web 浏览器检查 | 真实 Web 页面完整记录中显示“转盘元信息”“转盘遥测”，下载操作通过；测试账号与数据已清理 | `artifacts/servo-sync-fix-20261019/web-turntable-download.png` |
| 类型与构建 | Web/桌面 TypeScript 检查及生产构建通过；桌面构建仍有既有的大包体提示 | `artifacts/servo-sync-fix-20261019/typecheck.log`、`build.log` |

联调采用 Python 服务生成的模拟波形，其中 P2 转盘遥测由真实 `TelemetryWriter` 在隔离测试目录写入，P3 加入合成循环点位元信息。记录明确标识为模拟来源，报告 `hardwareTested=false`；这证明软件链路，不代表真实转盘采集验收。循环多点用例使用模拟设备或伪云接口；桌面主进程与真实 Web 联调用例使用普通模拟采集。

**真实 Windows 硬件验证仍待完成。** 现场需核对固件反馈、两轴方向/参考位/限位、实际停稳、串口异常、激光收尾以及完整循环行为。RSSI 进入/离开判据不具备同一叶片身份或旋转相位识别能力；手拨停止导致回波变稳也可能满足离开候选，需结合实际光路验证。

## UI Token 与视觉验收

设计依据：仓库上级 `原型/uploads/高保真原型设计方案_第2部分（ZCPT0107）.md` 第 1.2–1.5 节，以及 `packages/ui/src/styles.css` 的现有品牌/文字/状态颜色变量。本轮样式集中在 `packages/ui/src/field-turntable.css`，仅由桌面入口引入；Web 页面未增加此样式入口。

| 项目 | 调整及验收结果 |
| --- | --- |
| 色彩与状态 | 主色使用 `--accent`（#2D6CC0），文字、背景、边框、成功/警告/错误引用现有 Token；移除原分支未定义 `--border` 及另一套蓝色硬编码 |
| 字号 | 点位页标题20px/600，区块标题16px/600，操作及输入14px，表头13px/600，辅助文本12px；反馈数字等宽对齐 |
| 间距和控件 | 使用4/8/12/16/24/32px间距，输入和按钮最小32px，控件圆角6px、卡片8px；自定义下拉框右侧32px空间，保留键盘焦点可见性 |
| 手动点位页 | 分成连接与定位、反馈与状态、点位记录与回位；宽窗左右分区，窄窗纵向排列；点位表格操作保持间距，表格可横向滚动 |
| 采集前检查 | 参数与反馈按网格排布；8项预检改成双列；只对速度显示做两位小数格式化，消除浮点长尾 |
| 跟随流程 | 采集页右侧首先显示流程卡片；7步骤编号、当前步骤高亮、已存记录进度条；宽容器7列，侧栏2列；动作日志限制高度并独立滚动 |
| 激光与回波 | 激光确认与操作紧凑排列；三种RSSI结果分别成卡，保留中位数/P10/P90/样本数；操作与结果之间12px间距 |
| 安全与交互 | 未勾选安全确认时按钮仍禁用；运行中控制仍锁定；完成/异常状态无旧步骤高亮（保留原有行为）；第一阶段 UI 整理保留原事件与禁用逻辑；本次功能修复进一步补齐缺失参考信息的运动拦截 |

浏览器使用真实桌面 React 组件及隔离内存模拟反馈验收，未调用 Electron、实际串口、测振仪或远端服务。检查窗口为 **1366×768、1024×600**；点位页和循环页面未出现页面横向溢出。下拉框、点位表格、采集前检查、循环进度/动作日志/完成/异常状态、三种RSSI结果已检查。截图上方黄色工具条属于验收夹具，不会进入正式客户端。

| 截图 | 内容 |
| --- | --- |
| `artifacts/servo-ui-20261019/01-manual-before.png` | 调整前的点位页 |
| `artifacts/servo-ui-20261019/04-manual-after.png` | 调整后的点位控制与反馈 |
| `artifacts/servo-ui-20261019/05-points-select-after.png` | 记录表与自定义速度下拉框 |
| `artifacts/servo-ui-20261019/06-manual-compact-after.png` | 小窗口单列点位布局 |
| `artifacts/servo-ui-20261019/08-cycle-after.png` | 采集时优先展示循环进度 |
| `artifacts/servo-ui-20261019/09-cycle-log-after.png` | 日志与波形区域 |
| `artifacts/servo-ui-20261019/10-rssi-after.png` | 三种回波标定结果 |
| `artifacts/servo-ui-20261019/11-cycle-compact-after.png` | 小窗口循环布局 |
| `artifacts/servo-ui-20261019/12-cycle-error-after.png` | 流程异常状态 |
| `artifacts/servo-ui-20261019/13-preflight-after.png` | 双列预检反馈 |

补充检查：Web与桌面 TypeScript 检查通过；桌面生产构建通过（保留已有的大包体提示）；最终 UI 变更后 `test:field` 回归通过。日志在 `artifacts/servo-merge-20261019/`。预览及截图目录已被Git忽略，不包含实际设备或账号凭据。

本报告与功能、UI 修复一并纳入 `main` 提交；推送完成情况以 Git 远端提交核验为准。本次没有更新 115 服务器或 Windows 下载包。
