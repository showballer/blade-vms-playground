'use strict';

// Pure planning only until a versioned controller trajectory interface exists.
// Never accept renderer-provided feedback, capability claims or motion commands.
function motionTrialRequest(value) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || value.action !== 'preview' || Object.keys(value).some(k => !['action', 'config'].includes(k)))
    fail('当前仅支持整圈轨迹计算，尚未接入控制板轨迹执行协议');
  const ranges = { distanceM: [0.001, 10000], hubHeightDeltaM: [-10000, 10000], radiusM: [0.001, 1000], periodSeconds: [0.5, 3600] };
  const config = value.config;
  const keys = [...Object.keys(ranges), 'rotationDirection', 'axis1Sign', 'axis2Sign'];
  if (!object(config) || Object.keys(config).some(k => !keys.includes(k))) fail('无效的转速试运行参数');
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max)
      fail(`参数 ${key} 超出有效范围`);
  }
  if (!['clockwise', 'counterclockwise'].includes(config.rotationDirection)) fail('请选择叶轮旋向');
  for (const key of ['axis1Sign', 'axis2Sign']) if (![1, -1].includes(config[key])) fail('两轴方向必须为1或-1');
  return { action: 'preview', config: Object.fromEntries(keys.map(key => [key, config[key]])) };
}

module.exports = { motionTrialRequest };
