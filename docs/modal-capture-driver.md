# 模态同步采集驱动接口

桌面“模态采集”提供 FRF 和 SSI-COV 的任务、设备、采样率、时长、通道映射、标定、开始、实时预览、停止和批次保存流程。现有 Polytec 单点速度接收器不具备同步力/多响应采集能力，不能用该通道冒充完整 FRF/SSI 采集。

## 设备接入

服务端通过受部署配置控制的 `BLADE_MODAL_DRIVER=package.module:Receiver` 装载设备适配器。默认未配置，点击开始会给出缺少同步设备驱动的原因，不生成数据。该值不由界面传入，不支持从界面运行任意脚本。

适配器对象需提供 `run(plan, ready, samples, stop_event)`。仅在用户点击开始后实例化、连接设备。`plan` 是已校验的配置，包含：

- `deviceId`、`method`（`frf` 或 `ssi_cov`）、`sampleRateHz`、`durationSeconds`、`targetSamples`。
- `channels`：顺序固定，每项含 `id`、`hardwareChannel`、`pointId`、`quantity`、`direction`、`calibrationSource`、`scaleToSI`。
- `boundary`、`excitation`、`context` 和用户核对确认。

设备实际准备完成后调用一次：

```python
ready({
    'sampleRateHz': actual_rate,
    'synchronization': 'common_sample_clock',
    'clockSource': actual_clock_description,
    'channelIds': [channel['id'] for channel in plan['channels']],
})
```

`clockSource` 必须来自实际硬件同步方式。实际采样率必须与要求一致，通道列表与顺序必须一致。不得通过软件轮询时间、依次采集或波形拼接声称硬件同步。

然后持续调用 `samples(start_sample, rows)`：

- `start_sample` 是从 0 开始的公共采样序号，必须严格连续；丢包、重号或重置均报错。
- `rows` 为 N×C 的原始单位数值矩阵，各列与 `channels` 一致，一批 1～8192 行，有限数值。
- 服务统一按各通道 `scaleToSI` 转换一次；适配器不要重复转换。
- 硬件过载、断连、数据缺口等必须抛出异常，禁止补零、插值、伪造缺失通道或静默丢包。
- 使用有界连接和读取超时，持续检查 `stop_event`；到达目标样本数或手动停止时尽快退出。适配器在 `finally` 中停止 DAQ、断开连接并释放 SDK。
- 正常结束只发生于达到采集时长或用户停止。流提前消失会被判定为不完整记录。

硬件触发、量程、锤击重复及特定厂商设备枚举应由具体设备适配器进一步扩展；当前界面的开始方式为手动开始连续记录，不会声称已实现尚未接入的硬件触发。

## 保存与分析

原始接收批次先写入 `modal-captures/<session>/received.jsonl`，状态和采集配置写入同目录的 `session.json`。完整、连续且至少32点的同步记录才保存到正式模态数据集，附上原始文件SHA256、通道换算、时钟证据、源会话及是否提前停止。接收出错或服务中断保留原始数据并标记未完成，不进入完整分析批次。

完成后用户到“模态识别”选择该批次，使用已有 FRF 或 SSI-COV 计算引擎分析；频率分辨率、相干性、平稳性、稳定极点等仍由计算引擎核验。采集成功不保证输入一定满足模态识别条件。短时单次锤击不一定满足当前 Welch 半功率算法的低频峰宽分辨率要求，接入设备后需要针对激励方案做现场联调。

数值生成器仅存在于隔离的自动化测试，不作为生产采集驱动，也不会自动回退到数值样本。
