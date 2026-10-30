# 本机记录分析

独立的采集后分析命名空间，使用用户提供的统一规范 v1.1 和参考库 0.1.0。`reference/` 的 Python 文件保持参考实现原样，逐文件 SHA-256 见 `reference-source.json`。适配器只读取本机记录，不控制设备，不写回记录或当前测量配置。

## 当前桌面入口

桌面展示按《归档(3)》V1.4 分为“原始记录分析”和“叶片合成分析”。原始记录可先按任务、风场、风机、叶片逐级筛选，再选择一条具体测点、角度和时间的记录；改变上级筛选清空下级筛选，不自动开始分析。两页均保留去趋势、滤波类型、截止频率、阶数和窗函数；显式点击“开始分析”后才重算，改配置时旧结果标为待重新分析。

桌面请求增加可选 `workspace:{purpose:"signal"|"synthesis",algorithmOptions:{...}}`，应用层版本为 `desktop-workspace-1.4.0`。有效窗口、真实 FFT 样本数、Welch 公共窗、STFT 窗和统计频带从保存记录自动确定；不改变底层参考库，也不影响未使用 workspace 的 Web/兼容接口。零值或冻结区间仅在独立、已验证的无效证据支持时排除。各真实连续段独立分析，背景轮询不重绘保存的时频图。

合成页依次展示各点多角度波形、各点 Welch 谱、共同频带响应及各点跨有效角度的算术平均半峰峰值。几何使用逐记录快照；缺角、方向或配置冲突保留可用真实片段并说明原因。展示接缝参数由真实段长度和采样率推导，仍经过参考实现的幅值、斜率和上下文校验，不通过时保持断线。原始记录与历史诊断标记不覆盖，正式健康结论独立于可分析状态。

桌面已移除“导出分析结果”按钮，保留合成页汇总、带来源拼接和图表图片导出。低层 analysis 导出接口仍保留用于兼容现有调用。

## 接口

鉴权沿用本机服务，`POST /api/field/record-analysis`。所有请求携带 `action`。不接受外部文件路径、波形数组或任意模块名。

| action | 参数 | 结果 |
|---|---|---|
| catalog | 无 | `tasks`（业务任务、原始记录和真实计划）、`revision`、历史 `jobs` |
| start | `taskId`, `recordingIds?`, `scope`, `profile`, `config?`, `reviewWindows?`, `workspace?` | `jobId/status/completed/total/cacheHit` |
| inspect | `recordingId` | 分析前只读查看完整原始记录的保峰显示、经过范围和源哈希 |
| status | `jobId` | queued/running/complete/cancelled/failed，与质量状态分别保存 |
| result | `jobId`, `recordingId?`, `segmentId?` | `records/aggregates/coverage/chartAvailability/history`，指定记录时附 `detail.raw/segments` |
| extended | `jobId`, `resultId`, `kind`, `parameters` | 真实连续核心的 STFT、包络、带限位移/加速度；缺参数时返回原因 |
| extended（点位频带） | `jobId`, `resultIds`, `kind:"point_band"`, `parameters:{band_hz:[lo,hi]}` | 同频带逐段 RMS，方位内和方位间两级等权，逐项保留排除原因 |
| preview | `jobId`, `resultIds`, `expectedAzimuths`, `joinConfig` | 独立的 `series/blocks/joins`；每个拟合点的原始索引为 null，始终 `analysis_eligible:false` |
| export | `jobId`, `kind:analysis/summary/raw/preview`, `previewId?` | `{path,fileName,mimeType,bytes}`；仅在固定 cache/job/exports 内生成 |
| cancel | `jobId` | 请求取消后台任务；不触碰采集或原始文件 |

`scope` 为 `analysis`（默认可分析结果）或 `diagnostic`（全部记录复核）。旧 `formal` 请求兼容映射到 `analysis`，不再代表健康认证。逐条检查真实连续片段、候选窗口、实际停稳前触发与经过完整性；开启未停稳测试和历史 diagnosticOnly/validMeasurement 标记本身不阻断分析。实际停稳前经过、部分经过、模拟来源和人工改窗保留待复核，不进入默认分析汇总。所有源标记保留，健康结论单独保持未评估。旧版本缓存不会用于新口径。默认 `LOS_DIAGNOSTIC` 采用明示线性经验背景、无滤波、无转动补偿；`RAW_REVIEW` 无背景移除；`AXIAL_EQUIVALENT` 必须显式提供方向假设与投影门槛。未提供同步转速参考时返回具体原因，不读取转盘 rpm 充当风机 rpm。

`config` 字段沿用参考 `AnalysisConfig`；算法版本由服务端管理。`reviewWindows` 为 `{recordingId:{start,end,reason}}`，半开样本范围，必须明确理由，仅诊断集合可使用，并生成新版本。原始确认进入/离开事件不变。

## 数值和隔离

- 读取每份记录自己的 geometry、pointCycle 与时间快照。0° 等方位和叶片半径使用保存值；转盘指向校正系数不会乘到波形上。
- 候选范围严格为确认进入到离开，使用保存的连续时钟起点转换，**不使用旧分析入口的 +1 约定**。越界阻断分析但保留原始预览，不裁边、不补零。
- 原始 RSSI 未采样处为 NaN（JSON 为 null），不把前值填充成实测。非有限速度、超量程及时间断口拆分连续片段；默认 RSSI 仅标记疑似。
- 每次经过仅以最长合格核心为点位代表；先同方位重复平均，再对实际纳入方位等权。重复谱要求相同频率网格；重复波形要求相同确认进入偏移、采样率和真实窗长。没有实测相位，不做相位翻转或拟合重对齐。
- 计算使用完整真实连续数组。图表单条数组至多 2000 点，保峰并带源索引，绘图数组明确不可作为分析输入。STFT 仅限制显示网格，不改变计算值。
- 平滑预览必须显式配置；不存在默认 2 ms 桥。失败时保持分段结果。预览入口与分析入口隔离，所有分析只接收本 job 的真实结果 ID，不能上传拼接数组。
- 频带、边缘政策、几何或审核更改生成新 cache key，不覆写历史版本。未知几何不阻断视线诊断；三叶片、同方位重复或历史不足时返回原因，不生成假数据。
- 同一点的安装几何、方向、符号及参考快照不同会拆组；展示拼接也不可混用。跨批次趋势只纳入已确认几何且比较键一致的结果。

## 存储、运行与限制

固定根目录 `<field-data>/record-analysis-v1/<jobId>`，单后台计算线程，最多两个排队/运行任务。每个请求限同一业务任务的 200 条记录、单条最多 3000 万原始样本。源哈希包含 manifest 和原始分块，发布前再次核验；缓存使用参数、scope、窗口和算法版本。全部源读取在请求工作线程或后台线程，不获取采集/转盘锁。

展示拼接限制单桥 200 万、全预览 800 万样本，AR 阶数至多 128，拟合矩阵至多 200 万元素。超限返回明确原因，不静默改动配置或挤占设备控制线程。桌面已保存 workspace 的真实段允许 `preview` 使用 `automatic:true` 自动推导接缝参数；其他调用仍需显式 `joinConfig`。`extended` 的 `workspace_stft` 仅使用结果中保存的自动参数，不要求用户填写窗长。

结果 JSON、完整真实层与谱 NPZ、原始保峰预览、独立展示预览分别存储。重启保留完成结果；中断任务标记 cancelled。导出原始数据再次验哈希，保存原字节；分析导出保留真实连续边界、完整事件、参数、SI 单位及全部层/谱；统计导出保留源结果 ID、方位分母和质量；展示导出名含“仅展示_含拟合”，每行携带实测/拟合类型。

旧菜单和旧 `/blade-passes` 路径没有被改名或复用。本模块不自动上传 Web，也不调用风场数据、健康判定或模态识别。
