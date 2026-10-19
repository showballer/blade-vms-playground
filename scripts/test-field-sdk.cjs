const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSdkPath, isSdkFile } = require('../apps/desktop/electron/field-sdk.cjs');

test('native SDK discovery respects explicit selection, platform and bundled resources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { platform: 'darwin', resourcesDir: root, servicesRoot: path.join(root, 'service'), executable: '/python' };
  const sdk = path.join(root, 'acquisition', 'vendor', 'libDeviceCommunication.dylib');
  fs.mkdirSync(path.dirname(sdk), { recursive: true });
  fs.writeFileSync(sdk, 'fixture, not a loadable SDK');
  assert.equal(resolveSdkPath(options), sdk);
  assert.equal(isSdkFile(sdk, 'darwin'), true);
  assert.equal(isSdkFile(sdk, 'win32'), false);
  assert.equal(isSdkFile(path.dirname(sdk), 'darwin'), false);
  const missing = path.join(root, 'missing.dylib');
  assert.equal(resolveSdkPath({ ...options, configured: missing }), missing);
  assert.equal(isSdkFile(missing, 'darwin'), false);
  assert.equal(resolveSdkPath({ ...options, environment: { BLADE_POLYTEC_DLL: missing } }), missing);
  assert.equal(resolveSdkPath({ ...options, configured: sdk, environment: { BLADE_POLYTEC_DLL: missing } }), sdk);
});

test('Windows keeps its existing adjacent vendor DLL lookup', () => {
  const executable = path.resolve('fixture', 'BladeAcquisition.exe');
  assert.equal(resolveSdkPath({ platform: 'win32', executable }), path.join(path.dirname(executable), 'vendor', 'DeviceCommunication.dll'));
});
