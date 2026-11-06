# 模态识别合成数据（2026-11-06）

本目录保存桌面端“模态分析样本”使用的完整输入、计算结果、来源统计和生成脚本。所有波形均为数值合成，不能作为现场测量、验收实测证明或叶片健康结论。

| 方法 | 样本数 / 通道 | 通道 | 模型用途 |
| --- | ---: | --- | --- |
| 自由衰减 | 1920 | 1个速度响应 | 衰减拟合、固有频率和阻尼 |
| FRF 半功率带宽 | 65536 | 同步力与速度响应 | H1频响、相干性、半功率带宽 |
| SSI-COV | 30000 | 5个同步速度响应 | 稳定图、奇异值、阻尼及复振型 |

`数据/` 包含完整 JSON 与 CSV 时序、来源与假设、Git参考片段统计；`结果/` 保存原计算结果与参数汇总。`manifest.json` 保存完整输入文件原始字节的 SHA256，与桌面端预览中的 `inputSha256` 一致。

原始输入包为 `modal-demo-bundle-1`，内部 `dataset` 为 `modal-input-1`，来源为 `numerical_validation_only`。保留仿真来源，不导入现场实测数据库。桌面端直接载入已保存的数值样本预览，用户在“模态识别”选择该批次即可切换三种方法查看图表。合成样本不会进入健康判定。

这些样本使用仓库提交 `6359473` 的既有户外片段量级及噪声纹理作为缩放参考；0.75/2.0 Hz、2.5%/4%阻尼、振型及同步时钟是模型设定，并非从户外短片段中识别。完整来源见“数据/仿真来源与假设.json”。

## 复算及重新生成

直接验证已保存输入可运行：

```sh
PYTHONPATH=services/acquisition services/acquisition/.venv/bin/python scripts/verify-modal-samples.py
```

重新生成需要 acquisition 环境中的 numpy、scipy 和额外安装的 matplotlib。使用同一参考提交，在仓库根目录运行：

```sh
services/acquisition/.venv/bin/python data/modal-samples/20261106/generate_demo.py --repo .
```

脚本也会生成图表和HTML预览。生成器会记录运行时的 Git HEAD；如果当前提交不同，来源元数据摘要会变化，数值计算也可能因依赖版本出现微小差异。不要覆盖已保存输入后继续沿用旧的桌面输入SHA256。

同步采集的硬件接入方式见仓库 `docs/modal-capture-driver.md`；本目录不是设备采集驱动。
