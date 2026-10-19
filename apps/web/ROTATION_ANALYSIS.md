# Web 旋转测振

Web「旋转测振」包含叶片有效片段与连续记录阶次分析两条路径。Python 作为短生命周期的独立分析进程运行，无需启动 Electron，不连接设备或开启激光。

## 叶片有效片段

自动跟随站位记录使用此路径，不进入原有连续记录算法。

1. 桌面依次采集同一叶片的 P1、P2；自动同步完整原始文件及 `pointCycle`。Web「选择同叶片记录」准备当前采集端、同任务、同叶片的已上传记录，未完成上传的数量单独提示。超过 64 条时改为逐条选择当前记录加入分析工作区，再分批分析；切换页面会取消后续准备并丢弃迟到回复。
2. 或从新版桌面逐条导出完整 CSV / CSV.GZ 并离线导入。点位数据必须保留首行元数据和从零开始的全部样本，不能先在表格软件中删行；普通旧 CSV 不猜测任务、叶片或边界。
3. 在「叶片有效片段」选择任务、径向测点，可展开批次与站位调整记录，点击「筛选并分析」。默认去均值；RSSI 绝对下限为可选筛选条件，不替代采集时的进入/离开检测。
4. 有效候选区间为 `[handoff.entryConfirmedSampleIndex + 1, handoff.exitSampleIndex)`。剔除等待、确认尾部、超量程、无效值和缺失 RSSI；按 RSSI 的实际采样间隔处理。缺少确认进入或离开、长度不足 64 样本的片段不生成 FFT，排除原因可查看。
5. 波形保留原样本索引和时间，间隙不连线。每个连续有效段独立预处理与计算频谱，不能通过删掉间隙提高频率分辨率。长段 FFT 只使用中部最多 262144 点，图表抽稀只影响显示。
6. 同一个圆周站位下，分别汇总各径向点速度 RMS、峰值、峰峰值并比较幅值分布；不同站位不混算。跨批次 RMS 按有效时长加权，采样率不同不会增加该记录权重。结果可导出 JSON，包含原始记录、样本边界、算法、质量排除、哈希及统计。

每次最多 64 条记录、合计 800 万原始样本、128 个有效段。原始文件保持不变，重复同步/导入的同一站位副本不能重复计数。原采集时间和导入存储时间分别保留；它们均不能充当硬件共同相位参考。

当前数据没有共同相位参考，输出明确为沿激光视线的**速度幅值分布**，不输出伪相位、MAC 或实测振型。RMS 不等于位移振幅；视线投影与跨批次工况尚未补偿。叶片编号由现场人工指定，站位轮次不是编码器确认的叶轮转数。后续要生成有相位的工作变形，需要可靠共同参考；真实模态识别还需相应测量条件与算法。

此Web功能尚未部署到115。Windows 1.5.4测试版包含对应点位元数据同步和完整CSV/GZ导出，客户端安装更新不代表服务器也已更新；Windows软件验收见包内报告，真实设备验收另行进行。

## 本地环境与部署

- 默认 Python：`services/acquisition/.venv/bin/python`；Windows 为 `.venv/Scripts/python.exe`。未找到时使用 `python3` / `python`。
- `BLADE_ANALYSIS_PYTHON`：可配置部署机器上的 Python 可执行文件绝对路径。Web 单独部署时安装 `services/acquisition/requirements-web.txt` 中依赖；完整设备采集服务仍使用 `requirements.txt`。
- `BLADE_ANALYSIS_DATA_DIR`：可配置持久数据目录；默认项目 `.data/web-rotation`。部署时同时保留 `services/acquisition` 目录。
- Python 可执行文件、虚拟环境和数据目录属于运行期资源，路径调用用 Turbopack 忽略标注排除静态资源追踪。生产构建不会复制本机虚拟环境；部署机器仍需准备上面的 Python 环境和采集服务源码。
- 数据按 Web 账号与课题组的 SHA-256 目录隔离。界面和请求不接受服务器文件路径；账号沿用 Web 登录会话。
- 每个 Node 进程最多同时运行 2 个上传/分析任务，每账号同时 1 个；上传和分析各有 180 秒上限。多实例部署需共用账号排队机制或固定路由，当前为单实例本机部署。

## 文件格式

支持多测点 XLSX、UTF-8 CSV、Gzip 压缩 CSV（`.csv.gz`）。桌面导出的 CSV/GZ 可直接导入。XLSX 上限 16 MB，每测点最多 100 万点，每文件最多 8 点、合计 200 万样本及 400 万个数据单元格；工作表和共享文本按流解析，解压后上限 96 MB。CSV/GZ 上传上限 128 MB，CSV 解压后最多 512 MB，最多 800 万个连续样本；上传和 CSV 解析均按流处理。

时间列为 `time_s`（秒）；速度列为 `velocity_m_s` / `velocity_mm_s`。位移列为 `displacement_m` / `displacement_mm` / `displacement_um`，经差分换算为 m/s，换算依据会保存。通用 `value` 列要求导入时明确指定物理量和单位，不按幅值猜单位。

桌面导出首行协议：

```text
# BladeVMS {"format":"blade-vms-csv-1","source":"simulation","simulation":{"scenario":"baseline"},"sampleRate":1000,"samples":10000,"unit":"m/s","point":"P1","position":0.6,"rpm":1200}
time_s,velocity_m_s,RSSI_percent,overrange
```

`source=polytec_ivs500` 标为实测导入。`source=simulation` 或有效 `simulation` 元数据始终保留模拟标签；界面的来源选择不能覆盖为实测。导出样本数、采样率与数据不符时拒绝完整入库。缺 RSSI 使用空值，超量程为 0/1。原文件及质量列保存，不静默删除低回波样本；超量程区间由现有分析算法明确拒绝，用户可选择未超量程的连续区间。

同事的 `Pn_xL...` 工作簿会识别测点位置、RPM、quality、RSSI、keyphase 等列；来源标题中的 simulation 标记会保留。

## API

- `GET /api/v1/rotation/recordings`：读取当前账号记录。
- `POST /api/v1/rotation/import?filename=...&source=...&quantity=...&unit=...`：请求体为文件二进制流，`Content-Type: application/octet-stream`。
- `POST /api/v1/rotation/analyze`：请求体为 `RotationRequest` JSON。
- `POST /api/v1/rotation/blade-passes`：`{recordingIds, detrend?, rssiThresholdPercent?}`，返回带断点的有效片段与按站位分组的多点幅值分布。

导入和计算要求分析写权限，并记录审计；结果可导出完整 JSON，含源文件哈希、数据来源、质量统计、算法版本和全部图表数据。

## 计算范围

「连续记录阶次分析」仍采用用户给定的恒定 RPM 与 t=0 共同相位假设。变转速输入会额外提示；输入键相信号会保留，但本算法尚不将其作为真实相位触发。候选弯曲模板匹配不等同于实验模态确认。带点位站位元数据的间歇记录在界面和后端均阻止进入此路径。模拟数据的输出用于调试，不作为实测结论。
