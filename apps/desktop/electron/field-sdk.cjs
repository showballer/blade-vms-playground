const fs = require('node:fs');
const path = require('node:path');

function sdkExtension(platform) {
  return ({ win32: 'dll', darwin: 'dylib', linux: 'so' })[platform] || null;
}
function isSdkFile(file, platform) {
  const extension = sdkExtension(platform);
  if (!extension || typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== `.${extension}`) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
function resolveSdkPath({ configured, environment = {}, platform, executable, resourcesDir, servicesRoot }) {
  // An explicitly chosen SDK must fail visibly if it disappears; do not silently
  // substitute a different library or inherit a Windows DLL on macOS.
  if (configured) return configured;
  if (environment.BLADE_POLYTEC_DLL) return environment.BLADE_POLYTEC_DLL;
  if (platform === 'win32') return path.join(path.dirname(executable), 'vendor', 'DeviceCommunication.dll');
  const filename = platform === 'darwin' ? 'libDeviceCommunication.dylib' : 'libDeviceCommunication.so';
  const candidates = [path.join(resourcesDir, 'acquisition', 'vendor', filename), path.join(servicesRoot, 'vendor', filename)];
  return candidates.find(file => isSdkFile(file, platform)) || candidates[1];
}
module.exports = { sdkExtension, isSdkFile, resolveSdkPath };
