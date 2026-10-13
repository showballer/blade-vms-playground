# 2026-10-13 采集联动与 Windows 1.5.0 发布记录

状态：**Web 采集联动与 Windows 1.5.0 已发布，验收测试数据已清理**。Web 已切至下述 release，Windows CI、新版 Web 历史读取复验和下载入口验证已通过。安装包本机完整文件与服务器完整文件 SHA-256 一致；公开下载入口验证了元信息、HEAD 和首／中／尾三个 Range，没有从公开 URL 再次完整下载 199 MB。时间均按 Asia/Shanghai 记录。

## 发布标识

| 项目 | 本次版本 |
| --- | --- |
| 用户授权 | 部署采集联动至 115，发布新版 Windows 客户端并更新 Web 下载入口 |
| 正式入口 | `http://115.190.201.41:3000/` |
| 当前 Web release | `/opt/bladevms/releases/20261013-capture-1.5.0-web-retry` |
| Web 源码 | `fcdb01bb96a92978eca901605f1cda9184b129b2` |
| Next Build ID | `GIf9KCiWrjPA-LJ9QNbTR` |
| Windows 版本 | `1.5.0`，Windows 10/11 x64 |
| Windows 冻结源码 | `4bc6a31b1bac2213586ea028a3370f4d7084812a` |
| Windows CI | [38373263387](https://github.com/showballer/blade-vms-playground/actions/runs/38373263387)，全部通过 |
| 安装文件 | `BladeVMS-Setup-1.5.0-x64.exe` |
| 安装文件大小 | `199476018` 字节 |
| 安装文件 SHA-256 | `3263651602e1978ba534106a437678bcc4ebd13f6651900f2ec349f08b479fc3` |
| 已发布安装路径 | `/var/lib/bladevms/downloads/BladeVMS-Setup-1.5.0-x64.exe` |
| 下载入口 | [Windows 1.5.0 安装包](http://115.190.201.41:3000/api/desktop-download/windows)；Web 页头「下载客户端」也已更新 |

Web 源码在 Windows 冻结版本上追加历史波形读取的有限重试：只读 GET 遇到账号 worker 忙碌的 429 时，按 1、2、4 秒最多重试三次；仍失败时显示「重试读取」。后端并发锁不变。该补丁仅修改 Web 组件及其辅助函数，没有改变桌面运行模块，Windows 1.5.0 无需重新打包。

## 功能与数据变更

- 客户端在「设备与服务 → 账号与密码」绑定一次 Web 账号。安装界面默认 `http://115.190.201.41:3000`，认证、实时波形和原始上传共用同一服务地址。
- 成功联网登录后，开启「自动同步新采集」：采集中推送 CH1／RSSI 和时域、FFT、时频分析窗口；停止并完整保存后，自动分段上传全部原始记录并校验 SHA-256、样本编号及总数。
- Web「旋转测振」支持实时采集和离线导入；完整上传的记录可查看全程原始波形，并选择进入旋转分析。
- 普通断网不影响本机采集。有效会话恢复连接后自动重试，重启后需联网登录再续传。在线会话为 12 小时，目前不自动续签；30 天离线登录只用于本机工作。
- 服务端按角色、课题组和记录所有者授权；用户逻辑删除保留历史记录，并撤销网络会话。
- 数据库只执行增量结构迁移：创建 `captures` 表、为 `users` 增加可空 `deleted_at`。原有四个账号及业务数据保留，没有重置账号密码或重新导入本地数据库。
- 原始采集存储为 `/var/lib/bladevms/web-captures`，与旋转工作区 `/var/lib/bladevms/web-rotation` 分开。服务配置包括 `BLADE_CAPTURE_DATA_DIR` 和对应 systemd 写入权限。

当前 HTTP 地址可以使用；HTTP 不提供传输加密，客户端有相应提示。HTTPS 证书校验未关闭。安装包未代码签名。

## 已完成的验收与边界

| 验收层 | 结果与范围 |
| --- | --- |
| 本地源码与协议 | 同步队列 13 项、采集权限 44 项、采集存储契约 6 组、统一认证 29 项及主进程／IPC 桥接 6 项通过。Web 重试行为 4 项及双端 typecheck 通过。 |
| 本地完整联动 | 三测点持续实时帧和 2049-bin FFT、完整原始上传、SHA-256 与精确样本回读、断网恢复、丢响应后重启续传、CSV.GZ 离线导入及三点旋转分析通过。仅使用隔离账号和模拟数据，测试数据已清理。 |
| Windows CI | Windows Node 测试 92 项、Python 测试 98 项、安装验收 8／8 通过；打包后及实际安装后各验证三个模拟测点、冻结采集服务、实时分析、CSV/GZ 导出和同步模块。同步对端为本地内存协议测试端，逐字节核对原始块；此项没有连接 115，也没有连接真实设备。 |
| 115 在线源码联动 | `acceptance-report.json` 为 `passed: true`。Mac 上执行真实 `field-main`、统一认证、IPC、Python 模拟采集和云端队列；仅替换 Electron 窗口外壳，连接真实 115 Web/API。三个测点的实时波形、2049-bin FFT、自动上传、服务器文件 SHA-256 与样本回读、离线导入、三点 50 转分析通过。 |
| 115 浏览器交互 | 已观察持续实时采集、停止后完整上传，并成功查看 93,350 点／93.35 秒原始记录的全程概览、CH1 和 RSSI；三点 50 转分析正常。Web 补丁复验已通过：17:21:57 同时刷新记录并打开完整记录，实际产生 429；17:21:59 自动重试成功、17:22:00 子视图读取成功，界面无错误且正常显示完整波形。 |
| Windows 真实设备 | **待现场验证**：Windows 1.5.0 接入 IVS-500、厂商 SDK／UDP 实际传输、真实数据正确性、丢包及长期吞吐、激光操作未由上述模拟验收证明。 |
| 1.5.0 在线下载 | 已上传并切换入口。CI 产物中的完整 EXE 已下载到本机，通过 ZIP 成员 CRC 和 SHA-256；服务器拼接后的完整 EXE 校验得到同一 SHA-256。公开元信息为 1.5.0／available=true／199,476,018 字节，HEAD 为 200，首／中／尾三个 Range 均为 206 且与本机包逐字节一致；未从公开 URL 再次完整下载。浏览器下载弹窗确认 v1.5.0／190.2 MB。 |

115 浏览器首次历史读取遇到短暂 429，Nginx 显示同一秒有该账号的 `rotation/recordings` 请求；原始上传已校验完成，重新切换标签后读取成功。发布前补丁保留服务器锁，并为这一只读竞争增加有限重试和显式重试入口。17:21:57—17:22:00 的线上复验已真实触发这一竞争并验证自动恢复，未仅以静态检查代替浏览器验收。

本地证据均位于 `artifacts/capture-release-20261013/`：

- `local-e2e/flow-report.json`、`main-report.json`、`cleanup-report.json`：本地主流程、真实主入口装配及清理。
- `windows/release-verification.json`、`windows/evidence/`：Windows CI、安装及模拟协议验证。
- `public-download-verification.json`：17:35:58 元信息、HEAD、三个 Range 与在线健康检查；`online-download-1.5.0.png`：线上下载弹窗。
- `acceptance-report.json`：真实 115 联动，最终 `fixturesCleaned=true`。
- `acceptance-cleanup.json`：删除本轮两个临时账号、四条采集及关联文件；测试租户用户和采集均为 0，服务器原有四个账号保留。私有 fixture 和本机隔离测试目录也已删除，原业务记录保留。

不发布包含测试密码或令牌的 `fixture.private.json`、环境文件、数据库备份或本机凭据。

## 备份与回退

发布前备份目录为 `/opt/bladevms/rollback/20261013-capture-1.5.0`，包含完整 SQL gzip、旋转目录 tar、运行环境和 systemd 服务配置。备份仅管理员可读，不属于公开下载内容。旧 release 和旧 Windows 安装包保留。

代码回退时先停止新任务，等待或安排结束运行中的分析；根据备份记录原子切回前一 release 并重启 Web，恢复对应下载路径／版本配置，验证健康接口与下载。保留新增 `captures` 表、`deleted_at` 字段和所有新采集文件；**不要直接恢复发布前数据库或覆盖数据目录，否则会丢失上线后的新增数据**。若必须进行数据恢复，应单独评估并保存恢复期间的新数据。

后续完整备份须同时包含数据库、`web-rotation` 和 `web-captures`（包括 incoming、complete、latest.json），业务快照不替代原始二进制文件备份。
