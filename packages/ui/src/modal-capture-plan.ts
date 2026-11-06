export type ModalCaptureMethod = 'frf' | 'ssi_cov';
export type ModalCaptureChannel = { id: string; hardwareChannel: string; pointId: string; quantity: string; direction: string; calibrationSource: string; scaleToSI: number };
export type ModalCapturePlan = { method: ModalCaptureMethod; name: string; deviceId: string; sampleRateHz: number; durationSeconds: number; boundary: string; excitation: string; conditionsConfirmed: boolean; channels: ModalCaptureChannel[]; context: { windFarm: string; turbine: string; blade: string } };
export function modalCaptureDefaults(method: ModalCaptureMethod): ModalCapturePlan {
  const channels: ModalCaptureChannel[] = Array.from({ length: method === 'frf' ? 2 : 5 }, (_, i) => ({ id: 'ch' + i, hardwareChannel: 'AI' + i, pointId: method === 'frf' && i === 0 ? '激励点' : 'P' + (method === 'frf' ? i : i + 1), quantity: method === 'frf' && i === 0 ? 'force' : 'velocity', direction: 'flapwise', calibrationSource: '', scaleToSI: 1 }));
  return { method, name: `${method === 'frf' ? 'FRF' : 'SSI'}叶片模态测量-${new Date().toLocaleDateString('sv-SE')}`, deviceId: '', sampleRateHz: 128, durationSeconds: method === 'frf' ? 1200 : 600, boundary: '叶片固定，转盘不联动', excitation: method === 'frf' ? '带力传感器的激振器持续激励' : '环境宽带激励，采集期间工况保持近似平稳', conditionsConfirmed: false, channels, context: { windFarm: '', turbine: '', blade: '1' } };
}
export function modalCapturePlanError(p: ModalCapturePlan): string {
  if (!p.name.trim() || !p.deviceId.trim()) return '请填写试验任务和采集设备编号。';
  if (![p.sampleRateHz, p.durationSeconds].every(Number.isFinite) || p.sampleRateHz < 10 || p.sampleRateHz > 20000 || p.durationSeconds < 1 || p.durationSeconds > 7200) return '请设置有效的采样率（10～20000 Hz）和时长（1～7200 秒）。';
  if (Math.ceil(p.sampleRateHz * p.durationSeconds) * (p.channels.length + 1) > 700000) return '本批数据量超过上限，请降低采样率、时长或通道数。';
  if (p.channels.length < 2 || p.channels.length > 16 || new Set(p.channels.map(c => c.hardwareChannel.trim())).size !== p.channels.length) return '需要 2～16 个不同的硬件通道。';
  if (p.method === 'frf' && (p.channels.length !== 2 || p.channels.filter(c => c.quantity === 'force').length !== 1)) return 'FRF 需要一个力通道和一个响应通道。';
  if (p.method === 'ssi_cov' && (p.channels.some(c => c.quantity === 'force') || new Set(p.channels.map(c => c.quantity)).size !== 1 || new Set(p.channels.map(c => c.pointId.trim())).size !== p.channels.length)) return 'SSI 需要不同测点、相同物理量的同步响应通道。';
  if (p.channels.some(c => !c.hardwareChannel.trim() || !c.pointId.trim() || !c.direction.trim() || !c.calibrationSource.trim() || !Number.isFinite(c.scaleToSI) || c.scaleToSI <= 0)) return '请填写每个通道的测点、方向、标定依据及 SI 换算系数。';
  if (!p.boundary.trim() || !p.excitation.trim()) return '请填写叶片边界条件和激励方式。';
  if (!p.conditionsConfirmed) return '请确认试验条件与通道连接。';
  return '';
}
