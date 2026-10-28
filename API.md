# 业务 API

前缀 `/api/v1`，JSON UTF-8；响应禁止缓存。浏览器用 HttpOnly、SameSite=Strict 会话 Cookie；Electron 由主进程保存并发送 Bearer Token。模型端点只登记、不请求；没有真实设备/算法接口。

| 方法 | 路径 | 用途与授权 |
|---|---|---|
| GET | `/health` | 无需登录，数据库连通与集成状态 |
| GET / PUT | `/health/thresholds?baselineId=:id` | 登录后读取基线所属组的阈值投影；仅管理员可修改，需提交读取时的 revision |
| POST | `/health/trends` | 管理员/分析员从授权任务、基线与阈值派生归档；修订校验与并发去重 |
| POST | `/health/trends/:id/annotations` | 追加人工信号标记，可信身份/时间；同标记 ID 重试去重 |
| POST | `/health/trends/:id/annotations/:annotationId/withdraw` | 撤回需 reason，保留初始标记和处置历史 |
| POST | `/session` | `{username,password}` 登录，12 小时会话 |
| GET / DELETE | `/session` | 当前身份 / 撤销当前会话 |
| GET | `/bootstrap` | 当前身份与工作台所需业务数据 |
| GET | `/records/:kind`、`/records/:kind/:id` | 查询列表 / 单条，非管理员按课题组隔离；操作员再限制本人任务及关联结果 |
| POST / PUT / DELETE | `/records/:kind[/:id]` | 新增 / 修改 / 删除，按资源与角色校验 |
| PUT / DELETE | `/records/baselines/:id` | 修改必须携带当前 revision；删除额外要求 confirm:true；基线写入与审计事务提交 |
| GET / POST / PUT | `/users[/:id]` | 管理员查看、新增、修改用户；密码至少 8 位 |
| GET | `/logs` | 管理员审计查询；`paginated=1` 返回分页对象，省略时兼容最多 500 条数组 |
| GET / POST / DELETE | `/tokens[/:id]` | 管理员管理本人令牌；创建参数 `{name}`，有效期 30 天，明文仅创建时返回 |
| GET / POST | `/backups` | 管理员查看备份 / 为本人课题组创建业务快照 |
| POST | `/backups/restore` | `{id,confirm:"恢复业务数据"}`；恢复备份所属课题组的业务记录 |
| GET | `/export/:kind[/:id]?format=...` | 下载文件，继承该资源读取权限 |
| POST | `/sync/tasks` | 显式导入一份本机任务修订及关联分析；管理员/分析员/操作员，事务写入及重试去重 |
| GET / POST | `/batches` | 读取本人批次 / 创建批次与输入快照；管理员可查看全部，访客不能创建 |
| GET | `/batches/:id` | 批次配置、每任务每步骤状态、结果引用及进度，不返回原始输入采样快照 |
| POST | `/batches/:id/resume`、`/batches/:id/pause` | 请求体 `{}`；恢复 / 暂停后续步骤 |
| POST | `/batches/:id/step` | `{taskId,step}`；执行并原子保存单步，已完成步骤重试不重复生成分析 |
| GET / POST | `/imports` | 读取本人导入批次 / 登记文件记录及逐项校验结果，尚不创建任务 |
| GET | `/imports/:id` | 导入进度、错误、警告及任务引用，不返回原始输入快照 |
| POST | `/imports/:id/item` | `{index}`（从 0 开始）；任务与成功状态事务提交，重试复用原任务 |
| GET | `/imports/:id/pending` | 未完成项的原始记录数组，用于导出、修正后重新导入，不包含成功项 |

`kind`：`tasks`、`alerts`、`baselines`、`models`、`settings`、`templates`、`reports`、`analyses`、`backups`、`batches`、`imports`。备份、批处理及文件导入写入仅走专用接口，通用记录接口不能改写其状态。基线写入的版本与删除确认要求见“基线登记”；健康趋势归档仅通过其专用接口创建/标记。

操作员仅能读取/导出本人创建的任务，以及关联本人任务的分析、报告、告警；可以保存本人任务的基础分析（`time/fft/tf/filter/env/band/avg/feat/order/cut`），不能保存 `modal/damage`。操作员修改/删除分析还要求该分析由本人创建。列表、详情、导出和初始化接口执行相同的数据范围规则；初始化中的无读取权限资源返回空数组，不绕过授权。

## 用户、令牌与接口速查

用户接口仅允许 `GET /users`、`POST /users`、`PUT /users/:id`；令牌接口仅允许 `GET /tokens`、`POST /tokens`、`DELETE /tokens/:id`。其他路径/方法返回 405。用户新增的 `active` 是可选布尔值，省略默认 true，false 创建停用账号；字符串、数字或 null 返回 400。修改用户仍要求明确布尔状态，停用使已有会话失效。

二次开发页面提供六个精选业务接口的速查，不代替本文完整契约。GET/POST 即使路径相同也独立选择；写入条目仅展示正文/权限，不会由预览按钮发起写入。GET JSON 预览与 CSV 下载分开处理，取消下载不报告成功。

## 日志查询与导出

仅管理员读取；记录包含操作人、时间、动作、对象和结果。可组合 `actor`（显示名称包含）、`target`（对象包含）、`action`（精确）、`result`（精确）、`from/to`（YYYY-MM-DD，含首尾整日）。日期按数据库日志显示时间解释，不自动换算为浏览器时区。百分号、下划线及反斜线为字面文本，不是通配符。字段重复、过长、日期无效或起日晚于止日返回 400。

`GET /logs?paginated=1&page=1&pageSize=25` 返回 `{items,total,page,pageSize,actions,results}`；items 每条为 `{id,actor,action,target,result,time}`。页码 1～1000000，页容量 1～100；排序为时间倒序、ID 倒序。筛选在数据库中执行，不只过滤最近 500 条。actions/results 为管理员可见日志中的动作/结果列表，包含已记录等历史状态。未指定 paginated 时维持数组返回且最多 500 条，也支持上述筛选。

`GET /export/logs?format=csv|txt|xlsx|json&actor=...&from=...&to=...` 复用同一筛选，导出所有匹配页，最多 10000 条，超限返回 413 并要求缩小范围，不静默截断。导出字段保留 `actor_name/action/target/result/created_at`。不支持单条日志导出路径或日志修改。页面区分编辑中与已查询条件；修改条件后先查询再导出，查询失败保留旧结果并明确提示。

## 信号任务、已保存段与多测点对比

`POST /records/analyses` 的新信号工作流使用 `parameters.workflow:"signal-input-v1"`。`inputs` 是 1～6 个引用：整条任务为 `{kind:"tasks",id,revision}`；历史保留段为 `{kind:"analyses",id,segmentId:"startIndex:endIndex",revision}`。修订使用 `signalInput` 返回的 `canonical` 的 SHA-256，浏览器可调用 `signalRevision`。历史截取必须包含完整 `rotation-segments-v1` 矩阵，只能选择保留段，不能把已排除段或文字旧记录作为输入。

`compare:false` 为单输入，支持现有八种标签；`compare:true` 仅支持 `type:"time"`，至少两项。`alignment:"source"|"relative"` 控制对比显示原任务时间还是首点归零；两者都不意味着同步采集。同一课题组、同一对象、已注明且相同单位才可对比；合计最多 20000 点，超量明确拒绝，不截断或补点，可先保存小分段。

`type:"tf"` 的 STFT 配置支持 `parameters.windowLength`（16～65536 的整数）和 `parameters.overlapPercent`（有限数值，`0 <= value < 100`，单位为百分比，例如 50 表示 0.5 重叠比例）。提供非法值返回 400；Web 与 Electron 使用同一校验器。新界面默认窗长 1024、重叠率 50，重置只改当前草稿。旧记录缺失字段保持缺失，不自动回填。参数冻结在记录及数值导出的 metadata.parameters 内；不会根据它们执行真实 STFT 或改写固定演示矩阵。

Web/本机主进程读取有权限的输入，检查修订，时域矩阵由存储数据派生并忽略客户端传入幅值与来源。单输入输出时间/幅值两列；对比输出输入编号、源索引、原任务时间、显示时间、原始幅值五列，逐项元信息保留测点、采样率、单位、历史段标注及来源修订。其他标签仍是明确的演示矩阵，输入只作配置溯源，不执行算法。非法输入返回 400、无权限/输入删除返回 404、修订变化返回 409；快照过大返回 413。

新信号快照禁止通用 PUT 改写（405），可重新保存一份新分析。原任务后来修改、截取记录后来修改或删除，不重建已保存的信号结果。跨任务所有者的对比被服务端标为 `operatorRestricted`，操作员无法通过首任务读取他人波形；包含该对比的报告也继承限制。列表、初始化、详情、导出保持相同规则。离线回传仍传输已冻结的历史结果，来源引用是本机历史标识，不冒充服务端当前任务引用。

## 旋转有效段分析

通过 `POST /records/analyses` 保存，`PUT /records/analyses/:id` 更新时执行相同校验。请求包含 `name/taskId/type:"cut"`，以及以下 `parameters`：

- `workflow:"rotation-segments-v1"`；`sourceRevision` 为当前源任务指定业务字段稳定序列化后的 SHA-256（64 位小写十六进制）。两端共用 `packages/ui/src/rotation-data.ts` 的 `rotationRevision/rotationCanonical`，不对接口返回对象整体 JSON 直接哈希；权限与更新时间字段不参与。
- `config:{rpm,blades,source:"手动",mode:"period"|"manual",start,end}`，时间单位秒；转速非负、叶片数为 1～1000 整数。周期模式需正转速且每周期至少一个采样点，手动范围允许零转速。
- `segments` 为 `generateRotationSegments` 生成的完整候选列表，最多 200 项。`id/startIndex/endIndex` 及顺序须与参数匹配；客户端只能选择 `keep` 和人工 `label/quality/note`，备注最多 300 字，至少保留一段。所有区间为 `[startIndex,endIndex)`，索引从 0 开始。

服务端读取有权访问的原任务，重建边界及数值，忽略传入的 `result` 和伪造的 `source`。有效格式的过期源修订返回 409；非法参数、边界、段类型/质量、空保留列表或缺失原始波形返回 400。源任务变化包括采样率/采样点/元信息变化；更改后不得沿用旧选择。离线主进程执行相同校验。

结果是分析记录，不是新任务：`result.dataset` 四列依次为分段编号（从 1 开始）、源采样索引、原任务时间（秒）、原始幅值（源通道单位）。元信息保存完整人工标注、排除范围/原因、保留/排除点数、输入元信息和修订摘要。各段保留原始绝对时间，不重采样或压缩掉间隔。数值导出通过 `/export/analyses/:id?view=data&format=csv|txt|xlsx|mat|json`，继承任务读取范围。历史结果读取不从当前任务重新计算；离线回传按历史冻结结果迁移。

`type:"order"` 在当前界面仅保存明确标记为 `source:"demo"` 的原型阶次柱高和手动频率换算参数。键相/信号估计、自动稳定段识别、同步重采样和真实阶次算法未接入。

## 模态结果

`POST /records/analyses` 创建 `type:"modal"`，`PUT /records/analyses/:id` 更新时执行相同校验。只允许管理员和分析员写入；操作员/访客按原任务权限读取历史及导出，不能保存模态。新写入的模态记录需要以下 `parameters`：

- `workflow:"modal-preview-v1"`。
- `config:{test,method,damping,points,activeOrder,baselineId}`。`test` 为 `free` 或 `oma`；自由模态方法为峰值拾取、LSCF / PolyMAX、ERA，OMA 为 SSI、FDD；阻尼法为半功率带宽、曲线拟合、时域衰减。
- `points` 为 1～3 个不重复的 P1/P2/P3 演示位置，保存时规范为物理位置顺序；`activeOrder` 为 1～3 整数。`baselineId` 可为 `prototype`（明确的原型样例），或同课题组/同对象的有效基线 ID。
- `sourceRevision` 与旋转页采用同一任务业务字段 SHA-256（共享 `rotationRevision`）。`baselineRevision` 由 `modalBaselineRevision` 计算：登记基线包含 id/name/object/modal，以及存在的 source/status/note/version 字段；原型基准使用版本内固定定义，均为 64 位小写十六进制。不要将基线维护用的 `revision` 直接替代分析的 `baselineRevision`，两者规范化字段不同。

服务器读取授权任务与基准，验证修订后生成固定演示结果，不接受客户端传入矩阵或 `source:"real"`。任务/基准变化返回 409；非法配置、缺少修订、基准异对象/异课题组或频率无效返回 400；无读取权限仍按原有规则返回 403/404。主进程本机持久化共用校验与结果派生。旧模态记录仍可读/导出原记录 JSON，但只有频率数组而没有矩阵时不补造子结果；重新保存需提供新契约。

`result.dataset` 默认为参数表；`result.datasets` 保存以下四类数值表：

| 子结果 key | 数值内容 | 当前规模 |
|---|---|---|
| `parameters` | 阶次、固有频率 Hz、阻尼比 %、振型名 | 3 行 |
| `points` | 频率 Hz、每个勾选点的原型相对幅值 | 5 行，1+测点数列 |
| `shape` | 阶次、点名、归一化位置、相对振型值、未变形参考值 | 3×测点数行 |
| `baseline` | 阶次、基准 Hz、当前演示 Hz、变化 % | 原型基准 3 行；现有单阶基线 1 行 |

数值导出为 `/export/analyses/:id?view=data&dataset=points&format=xlsx`；四类均支持 CSV/TXT/XLSX/MAT/JSON。省略 `dataset` 使用默认参数表；未知子结果返回 400，不回退其他数据。任务原始波形不接受此子结果选择。历史记录导出使用已保存矩阵与元信息，不从当前任务/基准重算；导出元信息只附分析摘要，不重复嵌入其他子结果。

变化率按 `(当前-基准)/基准×100` 算出并保存 8 位小数，界面显示 2 位，防止数据库浮点序列化的末位差异。现有基线仅含一阶频率，不生成二、三阶频率。振型导出为固定示例节点，不导出动画相位，零参考线也不冒充已测正常态振型。报告保留全部子结果快照，并展示已保存的三阶频率与阻尼摘要。真实模态识别、同步多点响应和基准振型由未来算法接口提供，本阶段未执行。

## 任务文件导入

健康阈值与告警复核的详细约定见文末“健康监测”。

创建参数 `{id,filename,records}`：ID 为客户端生成的 1～64 位字母/数字/下划线/连字符，重试时保持不变；文件名最多 180 字；记录数组 1～50 条、UTF-8 JSON 总大小不超过 1.5 MB。每条独立校验：有效项 `pending`，非法项 `invalid` 并附原因。新批次返回 201，同账号/同 ID/同内容重试返回 200；相同 ID 不同内容返回 409。并发登记不会重复建批次。

`POST /imports/:id/item` 仅接收条目索引。有效项以新 ID 创建任务，同时保存 `completed/taskId/importedAt` 和审计；两者在同一个数据库事务中写入。成功项重试不重复创建，也不覆盖后续编辑；若原任务已删除或不可见则返回 409，不静默复活。无效条目返回 400，不影响其他有效项。网络/磁盘异常时客户端停止后续请求，恢复后先读取进度再继续。没有后台自动导入任务。

导入业务接口均限本人及本人课题组读取/执行，包括管理员；访客只读且不能创建。详情、通用列表/导出、初始化遵循同一规则，不返回输入大数组。专用 `pending` 读取原始未完成项，权限不放宽。`imports` 存于现有项目 `records` 表，参与业务备份/恢复，不增建数据库、容器或表。管理员有权创建的本课题组完整业务备份仍包含该组导入输入及进度，遵循备份权限；这不是对备份管理员的保密存储。

任务保留允许的业务字段，要求名称、对象、风机、测点、转速、叶片数、采样率及有效元信息。包含波形时按实际点数/采样率校正时长并返回警告；无波形需填写时长。文件中的 ID、账号、回传来源和导入来源不生效；设备类来源统一标记 `import`，明确的 `demo` 保留演示标记。可信 `importOrigin` 由后端生成，记录批次、条目序号、文件名及时间，后续任务 PUT 不可伪造。离线端共用校验与状态机，任务和进度原子写入本机工作区。

CSV 解析在界面完成，支持一列幅值或两列时间/幅值、表头、引号、BOM，以及本系统导出的带元信息原始波形 CSV。确认前展示可编辑元信息、采样率和幅值单位；时间列必须从 0 开始并匹配采样率，不静默忽略时间。频谱/特征数据集不能作为原始波形导入。JSON 任务数组逐条预检，不再用演示默认值悄悄补齐缺失的必填字段。

## 本机任务回传

```json
{
  "clientId": "持久化的本机工作区标识",
  "localId": "本机任务ID",
  "revision": "64位小写十六进制修订摘要",
  "task": { "name": "任务名称，其他字段同创建任务" },
  "analyses": [
    { "name": "FFT演示分析", "taskId": "本机任务ID", "type": "fft", "source": "demo", "parameters": { "nfft": 4096 } }
  ]
}
```

上述 `task` 仅表示结构示意，实际请求仍须包含创建任务必填字段。`clientId/localId` 仅接受 1～64 位字母、数字、下划线、连字符。最多 50 份分析，所有 `analyses[].taskId` 必须等于 `localId`；每份任务和分析均复用业务校验与角色权限。

- 新回传返回 201：`{taskId,analysisIds,revision,created:true}`；已成功版本重试返回 200、相同 ID 和 `created:false`。
- 幂等范围为服务器数据库中的用户、课题组、工作区、任务、修订。服务端对校验后的内容单独计算摘要；同一版本不同内容返回 409。
- 原生端从主进程本机存储取快照生成修订，不接受渲染层替换上传内容；确认后若本机修订或目标账号改变，需刷新并再次确认。
- 任务和分析以新 ID 在一个事务内写入，分析关联到新任务 ID；审计也在事务内。不会覆盖已有服务器任务，不会删除本机记录。
- 返回的 `syncOrigin` 由服务端生成，保留原工作区/任务/修订与导入时间，后续 PUT 不能改写此来源。
- 如果此前回传的记录被删除或恢复覆盖而缺失，重试返回 409，不静默重建；用户保存新的本机修订后可以重新回传。
- 原生端限制单次包不超过 2 MB；界面每批最多选择 50 项，逐任务回传，失败项保留选择。服务器无法确认时可安全重试；若服务器已确认但本机回执写入失败，会返回成功及警告。

`sync_imports` 为项目库内的回传去重账本，不属于可恢复业务快照；业务备份恢复不会恢复账号、会话、审计或回传账本。

## 批处理工作流

创建请求示例（替换 `taskIds` 为有权读取的实际任务）：

```json
{
  "id": "由客户端生成并在创建重试时保持不变的标识",
  "name": "叶片A批次",
  "taskIds": ["task-id"],
  "config": {
    "denoise": { "enabled": true, "method": "滑动平均", "low": 0.1, "high": 20, "order": 4, "windowLength": 16 },
    "cut": { "enabled": true, "start": 0, "end": null },
    "fft": { "enabled": true, "nfft": 4096, "window": "Hann" },
    "features": { "enabled": true, "names": ["RMS", "峰值", "峭度"] }
  }
}
```

`id` 实际须为 1～64 位字母、数字、下划线或连字符，推荐 UUID。名称最多 120 字；选择 1～50 个不重复任务，输入快照合计最多 8 MB。至少启用一个步骤。每任务执行顺序为 `denoise → cut → fft → features`，禁用步骤跳过。

- 新建返回 201；同一用户、课题组、标识及请求配置重试返回 200 和原批次，冲突返回 409。服务端取有权读取的原任务快照，不接受调用方传入伪造的输入、状态或结果。
- 创建后为暂停状态。先 `resume`，再逐项请求 `step`。工作台关闭或断网时不会在后台继续运行未提交的步骤；重新打开后可继续。当前没有 Python Worker 或真实算法任务队列。
- 配置与输入冻结在批次创建时；原任务后续编辑不改变此批次。需要不同配置/新数据时“复制配置新建批次”。原任务被删除或不再可见时，不执行未完成步骤。
- 公开状态包括 `completed/total/failed/paused/status` 和 `items[].steps[]`。步骤状态为 `pending/completed/failed`，记录 `attempts/error/analysisId/finishedAt`。200 响应也可能包含步骤业务失败，须检查状态，不能只看 HTTP 状态码。
- 每个步骤在同一事务保存结果、批次状态和审计。并发或丢失确认后的重试不重复创建分析。已完成结果被删除时返回 409，不静默重建历史记录。
- 降噪占位保留输入幅值；FFT 和特征使用固定演示值，均明确说明不是实际计算。截取按 `[start,end)` 时间区间映射到采样索引，保留绝对时间与精确幅值；`end=null` 表示该任务波形末尾，超出范围时失败。
- 分析类型对应 `filter/time/fft/feat`。`parameters` 保存批次、配置、输入元信息和 `sourceRange`；`result` 保存 `demo/note/columns/rows/inputCount`。结果查看和数值 CSV/TXT/XLSX/MAT/JSON 导出共用下文的数据集协议；原始记录 JSON 接口仍保留。
- 非管理员仅能读取本人创建的批次；操作员的源任务仍须本人所有。批次和分析包含在所属课题组的业务备份中。Electron 离线调用同路径和同一状态机，批次与结果在本机一次原子写入。
- 本机回传会上传任务的关联分析，包括已保存的批处理结果；当前不上传本机批次的调度状态或输入快照。回传包仍受 2 MB/50 份分析限制。

## 示例

创建任务（管理员/分析员/操作员）：

```json
{
  "name": "叶片A-工况3",
  "object": "风机叶片A",
  "turbine": "WT-03",
  "point": "P3 叶尖",
  "direction": "径向",
  "rpm": 15,
  "blades": 3,
  "sampleRate": 25600,
  "range": 10,
  "duration": 120,
  "status": "本地",
  "condition": "稳定运行",
  "source": "demo",
  "testTime": "2026-09-07T01:30:00Z",
  "environment": "现场，风速 8 m/s",
  "faultType": "未标注",
  "channels": [{"no": 2, "type": "velocity", "unit": "mm/s"}]
}
```

可选 `samples` 是至多 20000 个有限数值；`source=import` 表示用户导入，不代表算法已验证。PUT 合并已有字段并重新验证，忽略未知字段。

`testTime` 可为空；非空时须为含时区的 ISO 日期时间。`environment`、`faultType`、`note` 各不超过 2000 字。`channels` 最多 16 项：`no` 为 1～256 不重复整数；`type` 为 `displacement/velocity/acceleration/keyphasor/other`；`unit` 为 1～30 字文本。`blades` 必须为正整数。`raw_preserved` 由服务端根据实际保存的 `samples` 计算，请求不能强行将空波形标记为已保留。

保存报告（管理员/分析员）：

```json
{
  "name": "叶片A检测报告",
  "taskId": "已有任务的 ID",
  "sections": ["对象信息", "采集参数", "原始波形", "模态参数", "结论与建议"],
  "conclusion": "待实际数据复核。",
  "source": "demo"
}
```

POST 新建时，服务端验证任务可见性并生成 `taskSnapshot`、`analysisSnapshots`、`generatedAt`、`author`，这些字段不能由请求伪造。已保存报告的 PUT 只编辑标题、章节、结论和抬头配置，保留原任务/分析快照、编制人、生成时间和操作员可见性限制，并记录 `editedAt`。更换源任务返回 400；需要更新数据时，在界面选择“用当前数据新建”，通过 POST 另建报告，原报告不覆盖。没有快照的旧式报告在首次保存时补建当前快照。

报告及模板还支持 `organization`、`reportNumber`（各最多 120 字）、`logoData`（PNG/JPEG 的 base64 data URL，不超过 350000 字符，校验文件头）及 `logoAspect`（0.1～10）。不接受远程 Logo 地址或 SVG。批量生成界面逐份保存报告，保留每份成功状态；重试仅处理剩余项。

## 导出

- 通用：`csv`、`txt`、`xlsx`、`json`。
- `export/tasks/:id?format=mat`：数值 MAT v4，非算法结果；必须有已保存波形。
- `export/reports/:id?format=docx`：只读导出选定报告的章节、任务/分析快照、结论；有矩阵时输出原始波形/频谱等静态图和最多 8 行数值预览，保留单位及完整数据引用。长参数使用可分页段落，模态主表保留已存频率/阻尼，旧式文字结果按字段展示。
- `export/backups/:id?format=json`：完整业务备份；仅管理员。
- PDF 使用报告页面的浏览器打印能力，本阶段没有服务端 `/pdf` 接口。

报告侧栏的“导出报告数据”与普通 `/export/tasks/:id` 含义不同：前者使用已经授权并加载的报告内 `taskSnapshot` / `analysisSnapshots`，支持原始波形、分析主结果及模态等子结果的 CSV/TXT/XLSX/MAT/JSON，元信息增加 `report.id/name/generatedAt/frozen`。它不请求后来修改或删除的源记录，因此与历史报告一致；后者仍然导出当前任务。无矩阵的旧分析明确禁用数值导出，不补造数据。访客可下载已加载的未修改历史 Word，无需报告写入权限。

### 数值数据集导出

`GET /export/tasks/:id?view=data&format=csv|txt|xlsx|mat|json` 和 `/export/analyses/:id?view=data&format=...` 读取单个任务波形或已保存分析矩阵。权限与记录读取一致，操作员不能通过此接口导出他人的任务或关联分析。缺少 ID、未知格式、空数据和只有说明没有矩阵的旧分析返回 400；不会用演示波形补造旧结果。省略 `view=data` 仍为原来的业务记录导出。

统一结构为 `{schema:"blade-vms/dataset-v1",title,columns,rows,metadata}`。每列有 `key/label/unit/type`，类型为 `number` 或 `string`；矩阵须为 1～20000 行、1～32 列，不接受缺值、非有限数值或不一致的行长。元信息保留来源、参数、输入任务快照、时间、单位及采样范围（如原记录包含）；不从当前任务重建历史分析。新信号标签记录在 `result.dataset` 保存这一结构；原有批处理 `result.columns/rows` 可兼容读取。

- CSV/TXT：UTF-8 BOM，分别使用逗号和制表符；第 1 条记录为格式说明，第 2 条记录的第二列是完整元信息 JSON，第 3 条记录为数值表头，第 4 条起为数据。读取时用正规 CSV/TSV 解析器跳过前两条记录。负数保持数值文本，危险文本公式前缀加单引号。
- Excel：`结果数据` 页为真正数值/文本单元格，冻结首行并开启筛选；`元信息` 页的 `metadata_json` 按分片序号拼接后解析。分片不切断 Unicode 字符，避免 Excel 单元格长度限制丢失内容；文本不作为公式执行。
- MAT v4：`values` 为纯数值矩阵；`numeric_column_indices` 为原始数据集列索引（从 0 开始）；`metadata_json_utf8` 为完整元信息 UTF-8 数值字节，其中 `textColumns` 保留频带/特征/单位等文本列。没有数值列时明确拒绝 MAT。
- JSON：返回完整数据集对象，不是业务记录数组。要重新导入任务记录，请使用省略 `view=data` 的原始记录 JSON。

桌面离线使用同一个编码器。`blade:save-data` 仅接受 5 种数据格式和不超过 16 MB 的 Uint8Array；不接受渲染层指定磁盘路径，每次写入由原生保存窗口确认。取消返回 `{canceled:true}`，写入失败抛错。此能力无需服务器、数据库或 Python 服务。

MAT 每个任务对应 `wave_N`、`sample_rate_N`、`is_demo_N`、`metadata_json_utf8_N`。后者包含任务全部元数据（排除重复的采样数组），并增加 `sample_count`、`waveform_layout`。读取示例：

```python
from scipy.io import loadmat
import json
data = loadmat("BladeVMS.mat")
metadata = json.loads(bytes(data["metadata_json_utf8_1"].astype("uint8").ravel(order="F")).decode("utf-8"))
wave = data["wave_1"]  # 时间秒、原始幅值
```

## 失败响应

格式为 `{"error":"可读说明"}`。400 参数/确认错误；401 未登录或会话过期；403 权限/来源不允许；404 不存在或当前用户不可见；405 不允许的资源操作；409 重名或修订/回传冲突；413 请求过大；429 登录尝试频繁；500 服务错误。后台详细错误不返回客户端。

通用业务列表当前最多 1000 条；日志支持数据库分页查询，旧数组接口最多 500 条，日志导出最多 10000 条且超限明确报错。高频时序存储需后续数据接入阶段扩展。当前没有面向大文件的分块上传。

## 基线登记

基线为业务参数登记，不执行 `/damage/baseline` 等算法服务。GET `/records/baselines[/:id]`、初始化和普通记录导出按课题组可见性处理；管理员可见全部组，其他角色可读本组基线，操作员不按任务所有权限制基线本身。

POST `/records/baselines` 只允许管理员/分析员。`name/object` 必填（去除首尾空白后非空、原字符串不超过 200 字）；可登记 `rms/frequency/modal`（有限正数）、`score`（0～100）、`confidence`（0～1）。数值可缺省，`null` 表示明确清空，绝不填默认指标。`score/confidence` 仅用于当前原型健康面板演示，不是计算或认证的健康结论。`source` 为 `manual/demo`、`status` 为 `active/disabled`，新建缺省分别为 manual/active；`note` 为最多 2000 字说明。新建响应 201，服务器生成 ID、归属、所有者、`version:1` 和 `revision`，请求中的保护字段不生效。

PUT `/records/baselines/:id` 请求为要更改的领域字段加 `{revision}`，支持部分更新，省略的指标保留原值。`revision` 必须来自当前 GET/列表/初始化/写入响应，缺少、非法或陈旧版本返回 409，不静默覆盖。真实变更以行锁/事务写入 `version+1` 和审计；完全不变的提交返回原记录，不增加版本或审计。已有无版本、无来源的旧记录可读，读取不会写回；明确编辑后开始计版本，未提交来源时继续保持缺省。

停用通过 PUT `{revision,status:"disabled"}`，启用使用 `active`。停用基线不能用于新的趋势归档或模态对比；已经保存的独立结果/报告不改写。健康面板要求全部有效基线与演示显示字段；模态对比只要求同组同对象、启用且有效的一阶频率，不会为缺项补造指标。

DELETE `/records/baselines/:id` 必须发送 JSON `{revision,confirm:true}`，缺确认 400、陈旧版本 409。仅删除该条基线，不级联删除趋势、波形、模态或报告快照。列表界面建议不再使用时先停用。已保存历史继续遵守自身课题组/任务范围，恢复基线登记需使用有效业务备份。

管理员维护其他课题组基线时归属和所有者不变，审计属于目标组。登记副本使用 POST（忽略原 id/revision/version/ownerId/recordTenant），总是另建在当前登录组，初始版本重新为 1。本阶段基线管理只在 Web 两个入口提供，桌面离线工作区不增加基线编辑或算法维护接口。

## 健康监测

`GET /health/thresholds?baselineId=:id` 先验证基线可见性，再读取该基线所属课题组配置；不同组即使对象同名也不混用。响应仅含 `{id,tenant,revision,status,values}`，不返回一般系统设置、备份计划或模型端点。`status` 为 `missing/invalid/legacy/configured`；前两种 `values=null`，界面不作等级判定。旧配置缺少注意比例时只兼容补充 `warningRatio * 0.75`，显式标记 `legacy`。

PUT 请求为 `{revision,values:{rms,frequency,band,attentionRatio,warningRatio}}`。阈值必须是有限正数，比例满足 `0 < attentionRatio < warningRatio < 1`。新建使用 GET 返回的 `revision="missing"`，已有记录使用其不透明版本串；并发/过期版本返回 409。配置和审计在一个事务保存，沿用 `records/settings`，不新增数据库或表。管理员虽然可选择其他组基线，但修改目标始终是基线所属组，不是其本人组。公开健康检查仅为 GET `/health`，不会绕过阈值子路由的登录。

`values` 还可包含 `peak/peakToPeak/mainAmplitude`，分别为峰值、峰峰值、主频幅值的报警阈值（mm/s）；提供时须为有限正数，省略或 `null` 表示未配置。PUT 是整份配置替换，修改分级时须同时保留已有阈值。旧三指标配置不自动补充新阈值。`band` 使用演示任意单位 a.u.，不是实际频带积分或物理量换算。

前端按当前演示指标绝对值/报警阈值分为正常、注意、预警、报警，等于阈值时进入对应级别；总体显示已判定指标最高等级及判定覆盖数（最多 6 项）。未配置项不计为正常；仅部分指标正常时总体显示“未完整判定”。此规则只负责业务分级展示，不生成真实传感器测量、损伤推理或长期趋势。默认数值只出现在管理员明确保存前的配置草稿，不在读取失败时生效。

页面保存的 `damage` 演示记录含严重程度、定位、判据、完整结论、六指标及当时阈值/基线展示快照；正常样例不再附带异常定位或异常结论。报告将其展开为中文字段，不将指标数组作为原始 JSON 正文。此入口仍为 `source:"demo"`，不执行推理或认证任务真实健康状态。

`PUT /records/alerts/:id` 的复核请求只需 `{status,reviewNote}`。状态或意见变化必须提供 1～2000 字有效意见。服务端生成 `reviewer/reviewerId/reviewedAt` 并追加 `reviewHistory[]`（`status/note/actorId/actor/time`），请求不能伪造、替换或清空这些字段；相同状态和意见的重试不重复追加。并发更新使用行锁，复核历史与审计一起事务提交。仅管理员/分析员可写，继承原有记录可见性；关联任务必须在同一组。普通标题等编辑保留历史。

读取业务记录增加权威 `recordTenant` 字段，不能被请求伪造；Web 以该字段区分管理员可见的跨组同名对象与任务。健康面板“关联任务”决定只读溯源窗口和报告入口的任务 ID，报告保存仍由服务端生成任务/分析快照。

### 趋势归档与人工信号标记

`POST /health/trends` 请求 `{taskId,baselineId,startDate,sourceRevision,baselineRevision,configRevision}`。`startDate` 为有效 `YYYY-MM-DD`，范围 1900-01-01～2099-12-02。任务与基线须同对象、同课题组；阈值按基线所在组读取，`missing` 可归档为未判定，`invalid` 拒绝归档。任务修订使用 `rotationRevision`，基线修订使用 `healthBaselineRevision`；两者均为共享领域字段规范化后的 SHA-256，阈值修订直接使用 GET 阈值投影返回的字符串。非法输入返回 400，版本变化返回 409。

服务端在一个事务内读取授权任务/基线/阈值并派生结果，不接收客户端矩阵、来源或标记历史。同用户/组/任务/基线/修订/展示起日的并发请求只产生一份归档：首次 201，重复 200 并返回已有记录（包括后续标记）。若源版本已改变，旧版本 POST 返回 409；历史仍从记录 GET 读取。归档和审计始终属于源任务组，即使操作者是其他组管理员。

归档存于 `records/analyses`，`type:"health-trend"`、`parameters.workflow:"health-trend-v1"`；`result.dataset` 为默认趋势，`result.datasets.trend` 为 30 行，列为 `index/date/amplitude/frequency/modal/band/peak/peakToPeak/mainAmplitude/damping`，其中后八列均为变化率 %。`result.datasets.waveform` 仅在源任务已有采样点时存在，保留原始时间/幅值。趋势是固定原型样例、数值保存 8 位小数，不由任务计算，不对应当前指标绝对值；零线仅为变化率参考。波形与日期没有真实逐日映射，不执行漂移识别或异常剔除。

新归档的 `parameters.sampleVersion` 和趋势元信息为 `multi-indicator-demo-v2`，归档去重 ID 纳入此样例版本，避免新版八指标预览返回旧三指标归档。旧归档始终按实际存储的列键显示/导出，不补造缺列；新旧都沿用 v1 标记工作流。界面支持主要趋势、幅值指标、模态参数和全部指标分组，分组不裁剪导出数据。

`POST /health/trends/:id/annotations` 请求 `{id,target,series,startIndex,endIndex,label,note}`：

- `id` 为 1～64 位字母/数字/下划线/连字符，客户端对同次待确认提交保留该 ID；同 ID 同内容同用户重试不追加，改内容/换用户/已撤回则 409。
- `target` 为 `trend` 或已有的 `waveform`；趋势 `series` 为归档中实际存在的 `amplitude/frequency/modal/band/peak/peakToPeak/mainAmplitude/damping` 数值百分比列，波形为 `value`。旧归档中缺失的曲线不能被标记（400）。
- 范围为有效整数半开区间，`0 <= startIndex < endIndex <= 对应数据集行数`。
- `label` 为 `待复核/异常/已确认`；`note` 为非空、最多 1000 字。服务端生成 `actorId/actor/time/status:"active"`，忽略伪造身份/时间。
- 每份最多 200 条（含撤回），标记只追加，不改矩阵。撤回路径请求 `{reason}`（非空最多 1000 字），保存 `withdrawnById/withdrawnBy/withdrawnAt/withdrawalReason`，保留原字段；同用户同原因重复撤回不改历史，改原因返回 409。

上述写接口只允许管理员/分析员。GET `/records/analyses/:id`、列表、初始化和 `/export/analyses/:id?view=data&dataset=trend|waveform&format=csv|txt|xlsx|mat|json` 继承同一记录范围；操作员仅可读取关联其本人且尚存在任务的记录。其他角色在原任务/基线删除后仍按课题组读取独立归档。通用 POST/PUT/DELETE 及本机回传不能伪造或改写归档，更新仅通过上述标记/撤回接口；管理员整组备份恢复仍遵循其单独的确认流程。

数值导出的元信息含标记历史与源快照，未知子结果拒绝而不回退。“健康趋势与标记”报告章节汇总有效/撤回数量并引用完整数值/记录 JSON，报告 `analysisSnapshots` 固定保存生成时的标记状态，不随后续处置变化。

## 2026-10-27 测量对象、真实频谱与工况工作区

本节接口沿用已登录会话或 Bearer 认证。新增数据按当前课题组隔离；导入原始文件仍按当前用户隔离。分析、规则、复核、工况和报告写入要求管理员或分析员；访客只读。返回错误含明确原因，不能将异常响应当成“无数据”。

| 方法 | `/api/v1/` 后路径 | 说明 |
|---|---|---|
| GET / POST | `objects` | 列出或新增/更新对象；类型 farm/turbine/blade/position/campaign。修改须传 id 和读回的 revision。类型、编号和归属不能改写；active=false 归档。 |
| POST | `objects/default-points` | `{turbineId}`，仅为尚无叶片的风机生成 3×5 空位置。 |
| POST | `objects/adopt` | 显式将元数据完整的历史来源映射到对象，不改原始文件；返回 linked/skipped。P1～P5 按明确点名匹配。 |
| POST | `objects/link` | `{reference,context,revision}`，为一条来源绑定完整对象；初次 revision=null。 |
| GET | `wind-datasets` | 工况数据集摘要与对象列表，不返回完整 rows；含各指标数量和同时具有风速/转速的时间点数量。 |
| POST | `wind-datasets/preview-file?filename=...` | CSV/XLSX 原始文件体，单文件≤16 MB、25万行；返回账号隔离 token、识别列、编码、总行数及前5行，暂不入库。 |
| POST | `wind-datasets/import` | `{name,farmId,files:[{token,mapping}],timezoneOffset,units}`；1～8份文件按风机及相同时间合并，最多25万个时间点；确认单位和时区后保存。 |
| POST | `wind-datasets/preview` | 兼容旧接口 `{filename,base64}`，CSV/XLSX ≤4 MB、5万行，预览解析，不入库。 |
| POST | `wind-datasets` | 兼容直接传规范化 `{name,farmId,rows}`；1～250000行，按同风机、同时间、同指标拒绝重复，包括并发导入。 |
| GET | `measurements` | 来源、绑定、对象、分析摘要、规则及 revision。摘要不带大曲线，目录上限 5000。 |
| POST | `measurements/analyze` | `{reference,parameters,measuredAt?}` 或 `{references:[...],parameters}`；真实 Python Welch 分析并存档。 |
| POST | `measurements/synthesis` | `{farmId,campaignId,turbineId,bladeId,positionIds?,includeDiagnostic?,minHz?,maxHz?}`；当前账号可见且已关联的同任务叶片记录，最多64条。多角度有效段合并显示，各段独立 Welch 后做同频带多测点幅值比较，不生成未知相位；诊断记录需显式选择。返回原始来源、缺测原因、时间映射及合成结果，不改原始记录。 |
| GET | `measurements/result/:id` | 一条完整分析、曲线、原始区间、哈希、工况和复核。 |
| GET / PUT | `measurements/rules` | 读取规则；PUT `{rules,revision}` 防覆盖。 |
| POST | `measurements/review` | `{resultId,note,status,referenceApproved,range?,revision}`；status 为待复核/已确认/已关闭。 |
| POST | `measurements/reassess` | `{resultId}`，保留原频谱与曲线，用当前参考和规则产生新结果，不覆盖旧结果。 |
| GET / POST | `measurements/modal` | 历史列表或 `{campaignId,turbineId,azimuthDeg,frequencyHz}`，保存五点频带响应。 |
| GET | `measurements/reports?campaignId=&turbineId=&offset=0` | 报告历史，20 条/页。 |
| POST | `measurements/reports` | `{campaignId,turbineId?}`，生成真实结果快照。 |
| GET | `measurements/report-download/:id` | Word 下载，记录导出审计。 |

完整归属 `context`：

```json
{"farmId":"<风场ID>","turbineId":"<风机ID>","bladeId":"<叶片ID>","positionId":"<测点ID>","campaignId":"<批次ID>"}
```

来源 `reference` 为 `{kind:"capture"|"import"|"task",id:"..."}`。旧 task 摘要不能替代原始样本，须先导入真实波形才能运行新版频谱。分析参数示例：

```json
{"reference":{"kind":"import","id":"<记录ID>"},"parameters":{"windowSeconds":0.25,"fadeFraction":0.05,"detrend":"constant"}}
```

- `windowSeconds`：0.001～30；`fadeFraction`：0～0.2，仅展示平滑；`detrend`：none/constant/linear；可选 `rssiThresholdPercent`：0～100。
- 单条记录缺少实际时钟可显式提供含时区的 `measuredAt`；导入文件时间不被当作测量时间。多条合并要求每条保留实际测量时钟。
- 合并最多16条，同完整归属和圆周角、相同采样率；≤800万原始样本、≤128连续有效段。重复、跨点位、诊断/失败/模拟输入拒绝。
- Wind rows 结构：`{time:"2026-10-01T10:00:00+08:00",turbineCode:"WT-01",windSpeed:3.2,rpm:12,windDirection:180,powerKw:300,temperatureC:-13.6}`；至少包含一个指标，统一 m/s、rpm、deg、kW、℃，缺失不补0。规范化时间必须带时区，风机编号需属于选定风场。只有同一时刻风速和转速都存在且无冲突时，才用于工况匹配；不同指标可分次导入补充，已有指标不自动覆盖。
- 复核 `range` 为 `{startSeconds,endSeconds}`，指**压缩有效时间**，须落在 `[0,features.validSeconds]` 且结束大于开始。留空评价整条，不改原始数据。`referenceApproved=true` 另要求状态已确认、匹配工况与有效频率。
- 结果含完整对象快照、来源列表、真实时间、圆周角、两轴目标角、半径、工况来源、有效样本区间/哈希、算法版本与参数、Welch 分辨率和峰值候选、判据依据/参考 ID、人工复核；未测/缺失字段保持空值。
- HTTP 400：字段/层级/波形不合法；401：未认证；403：无权；404：来源或结果不存在；409：修订冲突/重复数据；429：真实分析进程繁忙；503/504：Python 环境/计算超时。

算法口径与现场待验项见 [服务端整改实施与验收](docs/服务端整改实施与验收.md)。不跨原始间断执行 Welch 窗，展示平滑不进入定量计算；无共同相位的五点幅值分布不等同固有振型。内置算法通过现有受限 Python worker 执行，不自动调用登记的第三方地址。

### 分文件风场工况导入（2026-10-28）

- 预览自动识别 UTF-8/GB18030 中文表头；每份文件至少映射 `time`、`turbineCode` 和一个指标。风速、轮毂转速、发电机侧有功功率、外界温度可以分别上传。
- `timezoneOffset` 为 `+08:00` 等明确偏移；原文件的无时区时间按此解释，已有时区的时间保留其实际时刻，统一存为 UTC。`units` 示例：`{"windSpeed":"m/s","rpm":"rpm","powerKw":"kW","temperatureC":"C"}`；映射到的每个指标都须确认单位，支持风速 km/h、转速 rps、功率 W/MW、温度 F 换算。
- 同批文件精确匹配风机和时间，不插值、外推或按行号拼接；同指标重复即拒绝。保存来源文件名、哈希、列映射、原始单位和时区用于追溯。
- token 只可由当前账号/课题组使用，24小时失效；失败可重新确认，成功删除临时源文件。临时区限制256 MB，上传读取超时180秒。原文件和合并完整行留在服务端，浏览器只收到小预览及保存摘要。
- 三维响应显示的 `±RMS` 仅是正负尺度参考；接口中的 `displacementRmsM`、`normalizedAmplitude` 仍保持非负。镜像参考不表示实测负峰值、真实运动边界或相位恢复。

### 统一测量页面：原始波形与异常区间

- `POST /api/v1/measurements/source-waveform`：`{reference:{kind,id}}`，返回有界原始波形预览和记录元数据，按来源权限检查，未关联对象的记录也可追溯。
- `POST /api/v1/measurements/analyze` 增加 `eventWindowMs`（5–200，默认20）、`eventRmsRatio`（2–20，默认4）、`eventSigma`（3–20，默认6）。
- `features.events` 包含有效时间区间、原始记录/样本/时间映射、RMS 比值与阈值。`confidence:null` 表示没有训练得到的损伤概率；输出为异常响应候选。
- 波形平滑仅影响展示。局部事件检测与 Welch 计算均使用原始连续有效片段。
