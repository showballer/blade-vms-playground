# 桌面端与 Web 叶片响应修改交接

## 本次内容

- 两端固定户外处理，移除测量模式选项。任务显示名称统一为“武川风场-R024-1101-第一组”和“武川风场-R024-1101-第二组”；保留源数据身份字段。
- 多角度展示接缝按相邻端部可分辨周期限制长度，目标不超过最短局部周期的 75%；无法识别周期时仅使用至多 8 个样本的短连接，不承诺小于周期。拟合保护失败保持断线。接缝连接到实测端点，旧 Web 预览缓存失效；拟合值不参与频谱、位移或健康计算。
- 健康监测可直接启动整叶片分析；三维空间幅值按计算位移作慢速同相示意，可暂停调速，不代表实测相位或模态振型。
- 风场数据集按租户、测量批次、风场、风机保存关联，重新打开恢复。每秒均值仅作为背景工况；工况匹配和健康评价资格分开显示。
- 实测位移振幅保留原值；增加一阶弯曲形状假设的递增拟合对照，不把拟合当实测或健康判据。
- 移除“正式评价待补充依据”黄色框，依据收进默认折叠详情；证据不足的正式评价显示灰色“健康状态未核验”。不硬编码“健康”结论。
- 第二组叶片 2 的 P3 有独立缺陷注入测试记录，健康监测显示“疑似损伤预警（测试副本）”。可在页面重新运行并查看四角度原样/注入波形及检测指标。

## 代码、数据与数据库的区别

Git 包含全部代码改动、迁移/恢复脚本和 `data/health-validation/20261109` 的完整配对测试波形、检测结果及校验清单。原始两组采集 ZIP 继续位于 `data/task-imports/20261105`；历史模态样本保留在 `data/modal-samples/20261106`。

Git 不包含数据库、账号/令牌、`.env.local`、`.data` 缓存。其他电脑拉取后需用自己的对象 ID 重新建立关联，不能把本机数据库 ID 当成固定业务标识。

## 在另一套开发环境恢复

1. 按项目现有流程安装依赖、配置 Web 数据库和 Python 分析环境，导入仓库两组原始任务数据及已确认的风场 CSV。风场时间语义使用每秒区间均值，风机业务编号为 R024。
2. 对已有同结构开发数据库，先预览下述迁移。该脚本会将旧测量对象归档、只激活两组任务及其子对象，并统一名称和风场关联。**仅用于这套两批次开发数据，不用于含其他业务批次的数据库。** 执行时自动备份被修改的对象，原始记录和分析文件不删除。

   ```sh
   node --env-file=apps/web/.env.local scripts/align-local-measurement-batches.mjs
   node --env-file=apps/web/.env.local scripts/align-local-measurement-batches.mjs --apply
   ```

   脚本匹配已有批次旧名/新名和已确认风场数据集名称；缺失或歧义会停止。若接收环境对象结构不同，按实际归属在页面关联，不套用本机 ID。

3. 在 Web 对两个批次各三片叶片完成整叶片响应分析。健康监测可直接点击“开始整叶片分析”。
4. 在仓库根目录预览并恢复服务端风场关联与缺陷测试；默认使用数据库中已有 admin 账号，也可传 `--username=分析员用户名`。脚本不创建账号、不复制凭据。

   ```sh
   node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-health-revision.ts
   node --env-file=apps/web/.env.local node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/restore-health-revision.ts --apply
   ```

   脚本先检查两组整叶片版本和数据集，再保存关联和评价。第二组叶片 2 的 P3 若已有同来源测试则保留，否则按当前采样数据重算；测试副本与原始处理结果独立存储。当前数据每片叶片应匹配 20/20 条，共 120 条。处理参数不同会导致重算数值变化。

5. 打开健康监测，选择第二组、叶片 2，进入“缺陷验证（测试）”；其余叶片保留真实的正式评价资格状态。

## 验证命令

```sh
npm run typecheck
npm run test:record-analysis
node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json scripts/test-health-followup.tsx
node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json scripts/test-web-health-revision.tsx
node_modules/.bin/tsx packages/ui/src/displacement-display-data.test.ts
PYTHONPATH=services/acquisition:services/acquisition/tests python -m unittest test_anomaly_validation test_short_preview test_point_displacement -q
PYTHONPATH=services/acquisition python scripts/verify-health-validation.py
npm run build -w @blade/web
```

Node 使用项目支持版本，Python 使用已安装 NumPy/SciPy 等依赖的分析环境。测试确认不会把单个尖峰判作持续异常，测试波形不进入原始分析导出，也不会被正式损伤判断采用。
