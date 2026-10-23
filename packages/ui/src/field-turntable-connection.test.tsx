import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldTurntableConnection, turntableConnectionEndpoint } from "./field-turntable-connection";
import { readSavedTurntableConnection } from "./field-turntable-port";
import { FieldTurntableManual } from "./field-turntable";
import { FieldAutoFollow } from "./field-auto-follow";
import type { FieldConfig, FieldStatus } from "./field-types";

test("connection form validates explicit network addresses and retains legacy serial support", () => {
  assert.equal(turntableConnectionEndpoint('tcp', '192.168.10.50', '5000', ''), 'tcp://192.168.10.50:5000');
  assert.equal(turntableConnectionEndpoint('serial', '', '', ' com7 '), 'COM7');
  for (const [mode, address, port, serial] of [['tcp', '192.168.10.50', '0', ''], ['tcp', '192.168.10.50', '65536', ''],
    ['tcp', '192.168.10.300', '5000', ''], ['tcp', 'user@192.168.10.50', '5000', ''],
    ['serial', '', '', 'tcp://192.168.10.50:5000'], ['serial', '', '', '/tmp/device'], ['bad', '', '', 'COM7']])
    assert.throws(() => turntableConnectionEndpoint(mode, address, port, serial));
  assert.equal(readSavedTurntableConnection(JSON.stringify({ version: 1, endpoint: 'tcp://192.168.10.50:5000' })), 'tcp://192.168.10.50:5000');
  assert.equal(readSavedTurntableConnection('{bad'), '');
  assert.equal(readSavedTurntableConnection(JSON.stringify({ version: 1, endpoint: 'http://x' })), '');
});

test("network connection controls expose the app5 default address and port without render-time device access", () => {
  const status: FieldStatus = { state: 'idle', service: { state: 'ready', dllConfigured: true, generation: 1 } };
  const props = { port: '', status, disabled: false, request: async <T,>() => { throw Error('must not connect on render'); },
    onStatus: () => {}, onBusy: () => {}, onConnectionChange: () => {} };
  const html = renderToStaticMarkup(<FieldTurntableConnection {...props} />);
  assert.match(html, /192.168.10.50/); assert.match(html, /value="5000"/);
  assert.match(html, /连接并检查/); assert.match(html, /手动控制、自动跟随和采集联动共用/);
  const busy = renderToStaticMarkup(<FieldTurntableConnection {...props} status={{ ...status, turntableBusy: true }} />);
  assert.match(busy, /<button[^>]*disabled=""/);
});

test("manual and automatic controls use the shared endpoint instead of separate serial settings", () => {
  const endpoint = 'tcp://192.168.10.50:5000';
  const status: FieldStatus = { state: 'idle', service: { state: 'ready', dllConfigured: true, generation: 1 } };
  const request = async <T,>() => { throw Error('render must not connect'); };
  const manual = renderToStaticMarkup(<FieldTurntableManual status={status} disabled={false} connectionPort={endpoint} request={request} />);
  assert.match(manual, /value="tcp:\/\/192.168.10.50:5000"/); assert.match(manual, /readonly=""/i);
  const config: FieldConfig = { name: 'test', deviceIp: '192.168.106.90', hostIp: '192.168.106.10', object: '', turbine: '', point: '' };
  const automatic = renderToStaticMarkup(<FieldAutoFollow connectionPort={endpoint} config={config} onConfig={() => {}} status={status} disabled={false}
    request={request} onStatus={() => {}} onRecords={() => {}} onService={() => {}} />);
  assert.match(automatic, /value="tcp:\/\/192.168.10.50:5000"/); assert.doesNotMatch(automatic, /aria-label="刷新转盘串口"/);
});
