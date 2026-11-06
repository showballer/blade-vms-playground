import assert from 'node:assert/strict';
import { modalCaptureDefaults, modalCapturePlanError } from './modal-capture-plan';
for(const method of ['frf','ssi_cov'] as const){
 const p=modalCaptureDefaults(method);
 assert.equal(p.channels.filter(c=>c.quantity==='force').length,method==='frf'?1:0);
 assert.match(modalCapturePlanError(p),/设备/);
 p.deviceId='daq';p.channels.forEach(c=>c.calibrationSource='known calibration');p.conditionsConfirmed=true;
 assert.equal(modalCapturePlanError(p),'');
 p.channels[1].hardwareChannel=p.channels[0].hardwareChannel;assert.match(modalCapturePlanError(p),/不同/);
}
const p=modalCaptureDefaults('ssi_cov');p.deviceId='daq';p.channels.forEach(c=>c.calibrationSource='known calibration');p.conditionsConfirmed=true;p.channels[1].pointId=p.channels[0].pointId;
assert.match(modalCapturePlanError(p),/不同测点/);
p.durationSeconds=7200;p.sampleRateHz=20000;assert.match(modalCapturePlanError(p),/上限/);
console.log('PASS method-specific channel plans, configuration validation and bounded acquisition');
