'use strict';

const path = require('node:path');
const { verifyPayload, writeNsisDefines } = require('../../../scripts/verify-windows-payload.cjs');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  // electron-builder's Arch enum uses 1 for x64; do not accidentally ship the x64 SDK in an ARM build.
  if (context.arch !== 1) throw new Error('BladeVMS acquisition installer supports Windows x64 only.');
  const desktopRoot = path.resolve(__dirname, '..');
  const result = verifyPayload(desktopRoot);
  writeNsisDefines(desktopRoot, result);
};
