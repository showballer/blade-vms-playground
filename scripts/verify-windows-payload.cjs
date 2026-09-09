'use strict';

// Runs on macOS/Linux/Windows. This is a structural packaging gate, not a claim
// that Windows installation or physical-device acquisition has been tested.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const SDK_EXPORTS = [
  'PolyOpenUdpEthernetCommunication', 'PolyCloseCommunication', 'PolyLastCommunicationStatus',
  'PolySendGetString', 'PolySendGetFloat', 'PolySendSetString', 'PolyItemListGetCurrentItem',
  'PolySendSetInt16', 'PolyOpenDataAcquisition', 'PolyCloseDataAcquisition', 'PolyStartDataAcquisition',
  'PolyStopDataAcquisition', 'PolyReadData', 'PolyExtractedSampleCount', 'PolyGetInt32Data',
  'PolyGetOverrange', 'PolyBaseSampleRateInHz', 'PolyChannelMaxValue',
];

function invariant(condition, message) {
  if (!condition) throw new Error(`Incomplete Windows x64 package: ${message}`);
}

function regularFile(file, minimum = 1) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { invariant(false, `missing ${file}`); }
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size >= minimum, `invalid or empty file ${file}`);
  return fs.readFileSync(file);
}

function inspectPe(buffer, label = 'PE binary') {
  invariant(buffer.length >= 128 && buffer.readUInt16LE(0) === 0x5a4d, `${label} is not a Windows PE binary`);
  const offset = buffer.readUInt32LE(0x3c);
  invariant(offset >= 64 && offset + 24 <= buffer.length && buffer.readUInt32LE(offset) === 0x4550, `${label} has an invalid PE header`);
  const machine = buffer.readUInt16LE(offset + 4);
  const sectionCount = buffer.readUInt16LE(offset + 6);
  const optionalSize = buffer.readUInt16LE(offset + 20);
  const optional = offset + 24;
  invariant(optionalSize >= 96 && optional + optionalSize + 40 * sectionCount <= buffer.length, `${label} has truncated PE sections`);
  const magic = buffer.readUInt16LE(optional);
  invariant(magic === 0x10b || magic === 0x20b, `${label} has unsupported PE optional header`);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const section = optional + optionalSize + index * 40;
    sections.push({ virtual: buffer.readUInt32LE(section + 12), size: buffer.readUInt32LE(section + 16), raw: buffer.readUInt32LE(section + 20) });
  }
  function resolveRva(rva, size = 1) {
    const section = sections.find(item => rva >= item.virtual && rva - item.virtual + size <= item.size);
    invariant(section, `${label} contains an unmapped RVA`);
    const result = section.raw + rva - section.virtual;
    invariant(result + size <= buffer.length, `${label} contains a truncated RVA`);
    return result;
  }
  function exportedNames() {
    invariant(directories + 8 <= optional + optionalSize, `${label} has no export directory`);
    const exportRva = buffer.readUInt32LE(directories);
    invariant(exportRva !== 0, `${label} has no exported SDK API`);
    const exportOffset = resolveRva(exportRva, 40);
    const count = buffer.readUInt32LE(exportOffset + 24);
    invariant(count <= 100000, `${label} contains an invalid export count`);
    const names = resolveRva(buffer.readUInt32LE(exportOffset + 32), count * 4);
    const result = new Set();
    for (let index = 0; index < count; index++) {
      const start = resolveRva(buffer.readUInt32LE(names + index * 4));
      const end = buffer.indexOf(0, start);
      invariant(end >= start && end - start < 512, `${label} contains an invalid export name`);
      result.add(buffer.toString('ascii', start, end));
    }
    return result;
  }
  return { machine, magic, exportedNames };
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    invariant(!entry.isSymbolicLink(), `symbolic link is not allowed in payload: ${file}`);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile()) files.push(file);
    else invariant(false, `unsupported payload entry ${file}`);
  }
  return files;
}

function verifyPayload(desktopRoot = path.resolve(__dirname, '../apps/desktop')) {
  const acquisition = path.join(desktopRoot, 'resources/acquisition');
  const prerequisites = path.join(desktopRoot, 'resources/prerequisites');
  const serviceFile = path.join(acquisition, 'BladeAcquisition.exe');
  const service = inspectPe(regularFile(serviceFile, 65536), serviceFile);
  invariant(service.machine === 0x8664 && service.magic === 0x20b, 'BladeAcquisition.exe must be native x64');
  const internal = path.join(acquisition, '_internal');
  invariant(fs.existsSync(internal), 'PyInstaller _internal directory is missing; copying only the service EXE is insufficient');
  const pythonDlls = fs.readdirSync(internal).filter(name => /^python3\d+\.dll$/i.test(name));
  invariant(pythonDlls.length === 1, 'exactly one bundled Python 3.x interpreter DLL is required');
  invariant(Number(pythonDlls[0].match(/^python3(\d+)\.dll$/i)[1]) >= 12, 'bundled Python must be 3.12 or newer');
  regularFile(path.join(internal, 'base_library.zip'), 1000);
  const dependencies = regularFile(path.join(acquisition, 'build-dependencies.txt'), 10).toString('utf8');
  for (const dependency of ['fastapi', 'uvicorn', 'websockets', 'pydantic', 'pyinstaller']) {
    invariant(new RegExp(`^${dependency}==[^\\s]+`, 'im').test(dependencies), `resolved ${dependency} version is not recorded`);
  }

  const sdkFile = path.join(acquisition, 'vendor/DeviceCommunication.dll');
  const sdk = inspectPe(regularFile(sdkFile, 65536), sdkFile);
  const exports = sdk.exportedNames();
  for (const symbol of SDK_EXPORTS) invariant(exports.has(symbol), `DeviceCommunication.dll lacks ${symbol}`);
  for (const license of ['LICENSE.md', 'LICENSE.LESSER.md', 'NOTICE.md']) regularFile(path.join(acquisition, 'vendor/licenses', license), 20);
  const sdkSource = regularFile(path.join(acquisition, 'vendor/source/DeviceCommunication-2021-source.zip'), 1000);
  invariant(sdkSource.readUInt32LE(0) === 0x04034b50, 'SDK corresponding-source archive is not ZIP');

  const nativeFiles = walk(acquisition).filter(file => /\.(exe|dll|pyd)$/i.test(file));
  for (const file of nativeFiles) {
    const pe = inspectPe(regularFile(file, 128), file);
    invariant(pe.machine === 0x8664 && pe.magic === 0x20b, `mixed-architecture binary: ${file}; every service DLL/PYD must be x64`);
  }
  let manifest;
  try { manifest = JSON.parse(regularFile(path.join(prerequisites, 'manifest.json')).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { invariant(false, `prerequisite manifest cannot be read: ${error.message}`); }
  invariant(manifest.architecture === 'x64', 'prerequisite manifest architecture must be x64');
  invariant(/^14\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(manifest.version), 'prerequisite manifest needs a four-part VC++ v14 version');
  invariant(/^[a-f0-9]{64}$/i.test(manifest.sha256), 'prerequisite manifest needs a SHA-256 hash');
  const redistributable = regularFile(path.join(prerequisites, 'vc_redist.x64.exe'), 1000000);
  // Microsoft's x64 installer may have an x86 bootstrapper. Payload architecture
  // is recorded by the authenticated Microsoft-download staging script instead.
  const redistPe = inspectPe(redistributable, 'vc_redist.x64.exe');
  invariant([0x14c, 0x8664].includes(redistPe.machine), 'VC++ redistributable bootstrapper is not a supported Windows PE');
  invariant(crypto.createHash('sha256').update(redistributable).digest('hex') === manifest.sha256.toLowerCase(), 'VC++ redistributable SHA-256 does not match authenticated staging manifest');
  return { service: serviceFile, python: pythonDlls[0], nativeFiles: nativeFiles.length, sdkExports: SDK_EXPORTS.length, vcRuntimeVersion: manifest.version, vcRuntimeSha256: manifest.sha256.toLowerCase() };
}

function writeNsisDefines(desktopRoot, result) {
  const buildRoot = path.join(desktopRoot, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.writeFileSync(path.join(buildRoot, 'payload.generated.nsh'), `; Generated only after successful complete-payload validation.\n!define BLADE_VC_MIN_VERSION "${result.vcRuntimeVersion}"\n`, 'utf8');
}

function selfTest() {
  assert.throws(() => inspectPe(Buffer.alloc(200)), /not a Windows PE/);
  const fixture = Buffer.alloc(512);
  fixture.writeUInt16LE(0x5a4d, 0);
  fixture.writeUInt32LE(128, 0x3c);
  fixture.writeUInt32LE(0x4550, 128);
  fixture.writeUInt16LE(0x8664, 132);
  fixture.writeUInt16LE(240, 148);
  fixture.writeUInt16LE(0x20b, 152);
  assert.equal(inspectPe(fixture).machine, 0x8664);
  assert.equal(inspectPe(fixture).magic, 0x20b);
  assert.throws(() => inspectPe(fixture).exportedNames(), /no exported SDK API/);
  fixture.writeUInt32LE(1000000, 0x3c);
  assert.throws(() => inspectPe(fixture), /invalid PE header/);
  assert.throws(() => verifyPayload(path.join(__dirname, 'nonexistent-payload')), /missing .*BladeAcquisition.exe/);
  console.log('Windows payload gate self-tests passed (invalid PE, x64 header, absent exports, truncated PE, missing bundle).');
}

module.exports = { verifyPayload, writeNsisDefines, inspectPe, SDK_EXPORTS };
if (require.main === module) {
  try {
    if (process.argv.includes('--self-test')) selfTest();
    else {
      const argument = process.argv.find(arg => arg.startsWith('--desktop-root='));
      const desktopRoot = argument ? path.resolve(argument.slice('--desktop-root='.length)) : path.resolve(__dirname, '../apps/desktop');
      const result = verifyPayload(desktopRoot);
      if (process.argv.includes('--write-nsis')) writeNsisDefines(desktopRoot, result);
      console.log(JSON.stringify({ completePayloadValidated: true, ...result }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
