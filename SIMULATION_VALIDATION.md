# 仿真验证边界与场景

本分支用于在没有真实旋转试验台时验证桌面端流程和算法接口。仿真结果统一标记
`source=simulation`，不能替代 IVS-500 现场测量精度、硬件同步和真实叶片损伤验收。

生成一组可导入的确定性旋转数据：

```bash
npm run simulate:rotation -- --output artifacts/simulation/rotation.csv --samples 20000 --rpm 1200 --blades 4 --seed 20260915
```

命令同时生成 `rotation.truth.json`。可用 `--sampleRate`、`--noise` 和 `--rpm` 构造不同
采样率、噪声及转速场景；当前脚本输出 CH1/CH2、RPM、键相和 RSSI1，供桌面端导入、回放
及后续实际算法接口使用。

如需直接走桌面端已有任务导入器，可同时生成任务 JSON（仅包含 CH1 波形，RSSI/RPM/键相
保存在 CSV 和 truth 文件中）：

```bash
npm run simulate:rotation -- --output artifacts/simulation/rotation.csv --task artifacts/simulation/rotation.task.json
```

## 可先验证的内容

| 需求 | 仿真输入 | 验证目标 |
|---|---|---|
| 数据采集与管理 | CH1/CH2、RPM、键相、时间戳、丢包和断线事件 | 采集、保存、恢复、回放和状态提示 |
| 旋转测振 | 恒速、变速、启动/停机、叶片数和 1X/2X/叶频 | 周期分段、同步重采样和阶次峰值 |
| 信号处理 | 已知频率、噪声、冲击、幅值调制 | FFT、滤波、时频、包络和特征值 |
| 健康预警 | 基线漂移、边带、冲击、裂纹/腐蚀标签 | 阈值、趋势、报警和人工复核 |
| 模态识别 | 已知固有频率、阻尼比和振型 | 识别值与标准答案的误差 |
| 报告导出 | 带标签的仿真分析结果 | Word/PDF/CSV/JSON 导出和追溯 |
| 二次开发 | 可控输入的示例算法 | 参数、版本、回滚和错误处理 |
| 权限与运维 | 多角色、越权、审计、备份故障 | 权限边界和恢复流程 |

## 标准答案

每个仿真任务应保存同名的 `*.truth.json`，至少包含：

```json
{
  "source": "simulation",
  "rpm": 1200,
  "blade_count": 4,
  "blade_passing_frequency_hz": 80,
  "fault_type": "tip_crack",
  "fault_position": 0.65,
  "expected_peaks_hz": [20, 40, 80],
  "natural_frequency_hz": 12.4,
  "damping_ratio": 0.018
}
```

验收时应记录频率/阶次误差、阻尼比误差、检测准确率、召回率和误报率，并在报告中
明确写出“仿真验证”。固定页面 demo 数据不能作为算法验收依据。

## 不能由仿真替代的项目

真实设备通信与驱动兼容性、激光速度精度、硬件通道同步和键相延迟、反光/遮挡影响、
长期 UDP 吞吐与丢包、断电恢复，以及真实叶片裂纹和腐蚀识别效果，必须在 Windows
实机和旋转试验条件具备后单独验收。
