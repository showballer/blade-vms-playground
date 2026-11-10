# 当前三组任务与健康参考恢复

此目录是当前交付入口。波形 ZIP 复用仓库已有文件，不重复打包；`manifest.json` 列出路径及 SHA-256。Git 更新不会自动改写桌面本机记录或 Web 数据库。

| 任务 | 归属 | 记录 | ZIP 目录 |
| --- | --- | --- | --- |
| 武川风场 R001 风机测量任务 | 武川风场 / R001 | 3 叶片 × 5 测点 × 4 角度 = 60 条 | `data/task-imports/20261105/1101-78m-背景塔桶-第二组_桌面端导入_2026-11-02` |
| 武川风场 R024 风机测量任务 | 武川风场 / R024 | 60 条 | `data/task-imports/20261105/第三组全流程_桌面端导入_2026-11-04` |
| 化德风场B071-20 | 化德风场 / 020# | 60 条 | `data/customer-demo/20261110` |

## 桌面导入

1. 打开“记录分析 → 叶片响应分析 → 导入户外分段”。
2. 武川每个任务一次选择对应目录的三个叶片 ZIP；化德一次选择五个 `P*-recordings.zip`。不同任务分次导入。
3. 按上表填写任务、风场、风机。检查预览共 60 条、3 个叶片、每叶片 5 测点，再确认导入。
4. 武川两组的位置沿用中心至叶尖 70.5 m、中心高度 90 m、首尾各预留 10%，P1～P5 半径为 7.05、21.15、35.25、49.35、63.45 m；仪器至叶轮 78 m。位置是估算值，78 m 不作为测点半径。
5. 在叶片响应分析中选择任务与叶片，分析并保存。Web 需另行上传原始记录和处理结果；导入桌面不等于已经同步到 Web。

## 武川健康参考

`wuchuan-reference.json` 保存六片叶片的分析配置、120 条来源哈希与五类实测计算指标，供恢复时核对。没有账号、密码、会话或本机数据库备份。

用户于 2026-11-10 将这两组指定为健康参考样本。每台风机分别建立 `response_reference` 标准，按测点与角度比较速度 RMS、半峰峰值、响应峰频率、峰值因子和峭度。工况不作为此模式的强制前提；缺失工况仍如实保留。未更改波形、工况日期、历史修订标记，也不使用递增拟合的位移展示值作健康指标。

参考成员回代正常代表当前样本处于自己定义的包络内，不是独立损伤检出验证。后续实测需同口径独立数据验证；结构健康结论仍走复核流程。化德继续使用自己的冻结参考与检测算法。

在仓库根目录，安装依赖、初始化项目数据库并创建目标账号后执行：

```sh
# 只验证三个任务 ZIP 和配置的校验和，不连接数据库
node node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-wuchuan-health-reference.ts

# 已有武川两组完整 Web 分析版本时，只核验数据，不写入
node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-wuchuan-health-reference.ts --check-db

# 核验通过后，发布现有分析版本、建立/复用参考，再计算健康筛查
node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-wuchuan-health-reference.ts --apply
```

可追加 `--username=用户名`，默认 `admin`。脚本先核对两个任务的全部来源与指标，任何差异均停止，不会覆盖原始记录或放宽阈值来强行通过。操作前后审计保存在被 Git 忽略的 `artifacts/wuchuan-reference-restore-*` 中。相同来源版本重复执行不会重复建立标准。

空数据库需要先完成上面的导入、上传及逐叶片分析。若重新导入后原始来源哈希/处理策略不同，脚本会拒绝套用这份参考；应核对处理配置或通过页面重新确认健康样本。脚本不是整库还原，也不重置账号。

## 化德与风场数据

完整数据、时间口径、冻结参考与分析参数在 `data/customer-demo/20261110/settings.json`；该目录 `manifest.json` 校验所有文件。包含武川 R024 的 18,600 条工况、化德 020# 的 1,440 条分钟工况。沿用文件中的归属与时间，不移到 R001，不修改日期以制造同期匹配。

```sh
# 先只读校验
node node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-customer-demo.ts
# 增量恢复化德、风场数据及检测配置；已有冲突数据会停止
node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-customer-demo.ts --apply
node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/verify-huade-demo-detection.ts
```

预期：武川六片参考成员每片 100 项比较、0 项超限；化德叶片 1/3 正常，叶片 2 有 31/100 项超限、高风险预警，三片工况各 20/20。化德构造信号的来源属性与既有判据保持不变。
