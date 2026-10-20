'use strict';
const net = require('node:net');
const { isTurntablePort } = require('./field-turntable-port.cjs');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ranges = {
  distanceM: [0.001, 10000], hubHeightDeltaM: [-10000, 10000], radiusM: [0.001, 1000],
  arcDegrees: [0.1, 30], nominalPeriodSeconds: [0.5, 3600], maxOutputRpm: [0.02, 10],
  maxOutputAccelerationDegS2: [Number.MIN_VALUE, 5000], motionRampSeconds: [0.001, 10],
  commandLatencyMs: [0, 5000], axisStartSkewMs: [0, 5000], syncUncertaintyMs: [0, 5000],
  maxPeriodVariationPercent: [Number.MIN_VALUE, 20], maxSyncAgeSeconds: [Number.MIN_VALUE, 300],
  maxApproximationErrorMm: [Number.MIN_VALUE, 1000], maxPredictionErrorMm: [Number.MIN_VALUE, 1000],
};
function configuration(value) {
  const allowed = [...Object.keys(ranges), 'bladeId', 'pointId', 'pointName', 'materialMark', 'axis1Sign', 'axis2Sign',
    'rotationDirection', 'frontFacingConfirmed', 'motionTimingConfirmed'];
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('无效单点参数');
  const result = {};
  for (const [key, limits] of Object.entries(ranges)) {
    if (value[key] === undefined && !['distanceM', 'hubHeightDeltaM', 'radiusM'].includes(key)) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < limits[0] || value[key] > limits[1])
      throw invalid(`单点参数 ${key} 超出范围`);
    result[key] = value[key];
  }
  for (const key of ['bladeId', 'pointId', 'pointName', 'materialMark']) {
    if (value[key] === undefined && key !== 'materialMark') continue;
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key.endsWith('Id') ? 80 : 120) || value[key].includes('\0'))
      throw invalid('请填写有效叶片、测点和材料标记');
    result[key] = value[key].trim();
  }
  for (const key of ['axis1Sign', 'axis2Sign']) if (value[key] !== undefined) {
    if (![1, -1].includes(value[key])) throw invalid('两轴方向必须为1或-1');
    result[key] = value[key];
  }
  if (value.rotationDirection !== undefined) {
    if (!['clockwise', 'counterclockwise'].includes(value.rotationDirection)) throw invalid('无效叶轮旋向');
    result.rotationDirection = value.rotationDirection;
  }
  for (const key of ['frontFacingConfirmed', 'motionTimingConfirmed']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw invalid('标定确认必须为布尔值');
    result[key] = value[key];
  }
  return result;
}

// The renderer supplies configuration, never service URLs, timestamps, readback
// anchors or trusted upload session IDs. Python owns planning and all actuation.
function singlePointRequest(value, { captureSessionId } = {}) {
  if (!object(value) || !['preview', 'prepare', 'mark', 'reset_sync', 'arm', 'cancel'].includes(value.action))
    throw invalid('无效单点跟随操作');
  const action = value.action;
  const allowed = action === 'preview' ? ['action', 'config'] : action === 'prepare'
    ? ['action', 'config', 'capture', 'sessionId', 'commandId', 'confirmLaser', 'confirmStaticPoint', 'confirmGeometry']
    : ['action', 'sessionId', 'commandId', ...(action === 'arm' ? ['confirmMotion'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('单点请求包含不支持的字段');
  const body = { action };
  if (action !== 'preview') for (const key of ['sessionId', 'commandId']) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(value[key])) throw invalid('无效单点会话或命令编号');
    body[key] = value[key];
  }
  if (['preview', 'prepare'].includes(action)) body.config = configuration(value.config);
  if (action === 'prepare') {
    for (const key of ['confirmLaser', 'confirmStaticPoint', 'confirmGeometry']) {
      if (value[key] !== true) throw invalid('请确认静止测点、几何标定和激光采集');
      body[key] = true;
    }
    const capture = value.capture;
    if (!object(capture) || !isTurntablePort(capture.port) || net.isIP(capture.deviceIp) !== 4 || net.isIP(capture.hostIp) !== 4 || capture.deviceIp === capture.hostIp)
      throw invalid('请填写有效且不同的设备/本机IP和转盘串口');
    body.capture = { deviceIp: capture.deviceIp, hostIp: capture.hostIp, port: capture.port };
    for (const key of ['name', 'object', 'turbine', 'point']) {
      const text = capture[key] ?? (key === 'name' ? null : '');
      if (typeof text !== 'string' || text.length > 120 || text.includes('\0') || (key === 'name' && !text.trim())) throw invalid('请填写有效采集任务信息');
      body.capture[key] = text.trim();
    }
    if (capture.windFarm !== undefined) {
      if (typeof capture.windFarm !== 'string' || capture.windFarm.length > 120 || capture.windFarm.includes('\0')) throw invalid('无效风场编号');
      body.capture.windFarm = capture.windFarm.trim();
    }
    if (captureSessionId !== undefined) {
      if (typeof captureSessionId !== 'string' || !/^[a-f0-9]{32}$/.test(captureSessionId)) throw invalid('无效上传会话编号');
      body.capture.captureSessionId = captureSessionId;
    }
  }
  if (action === 'arm') {
    if (value.confirmMotion !== true) throw invalid('请明确允许执行一次短弧运动');
    body.confirmMotion = true;
  }
  return body;
}
module.exports = { singlePointRequest };
