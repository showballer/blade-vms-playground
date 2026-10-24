'use strict';

// Standalone Apple Silicon package. Never read the developer's bootstrap or profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, scryptSync, createHash } = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'apps/desktop');
const serviceRoot = path.join(root, 'services/acquisition');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--python', '--output', '--sdk-dir'].includes(key) && value && !value.startsWith('--'),
    'Usage: package-macos.cjs [--python /path/to/python] [--output /directory] [--sdk-dir /vendor]');
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(process.platform === 'darwin' && process.arch === 'arm64', 'Build on an Apple Silicon Mac with ARM64 Node.js.');
const python = options.python || path.join(serviceRoot, '.venv-build/bin/python');
assert.ok(fs.existsSync(python), 'Create services/acquisition/.venv-build and install requirements-build.txt first (docs/MAC_PACKAGING.md).');
const vendor = options['sdk-dir'] || path.join(desktop, 'resources/acquisition/vendor');
for (const name of ['libDeviceCommunication.dylib', 'licenses', 'source'])
  assert.ok(fs.existsSync(path.join(vendor, name)), `Missing SDK payload: ${name}; see docs/MAC_SDK_BUILD.md.`);

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const work = fs.mkdtempSync(path.join(artifacts, `mac-package-${stamp}-`));
const output = options.output || path.join(desktop, 'release');
const stage = path.join(work, 'desktop');
let step = 0;
function run(file, args, extra = {}) {
  const log = path.join(work, `${String(++step).padStart(2, '0')}-${path.basename(file)}.log`);
  const fd = fs.openSync(log, 'w', 0o600);
  try { execFileSync(file, args, { cwd: root, stdio: ['ignore', fd, fd], ...extra }); }
  catch { throw Error(`Build step failed: ${path.basename(file)}. See ${log}`); }
  finally { fs.closeSync(fd); }
  return fs.readFileSync(log, 'utf8');
}
function copy(from, to) {
  // Node's default rewrites symlinks to absolute build paths, breaking standalone signing.
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}
function assertLocalLinks(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) {
      const relative = path.relative(bundle, fs.realpathSync(file));
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `External bundle symlink: ${file}`);
    } else if (item.isDirectory()) assertLocalLinks(file);
  }
}

let bundle;
async function main() {
  console.log('Checking Mac build prerequisites…');
  run(python, ['-c', "import platform,sys,PyInstaller; assert sys.platform == 'darwin' and platform.machine() == 'arm64'; assert sys.version_info >= (3,12)"]);
  run('/usr/bin/lipo', [path.join(vendor, 'libDeviceCommunication.dylib'), '-verify_arch', 'arm64']);
  console.log('Building UI and standalone acquisition service…');
  run('npm', ['run', 'build', '--workspace=@blade/desktop']);
  run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', path.join(work, 'service-dist'),
    '--workpath', path.join(work, 'service-build'), path.join(serviceRoot, 'BladeAcquisition.spec')]);
  const frozen = path.join(work, 'service-dist/BladeAcquisition');
  run(python, [path.join(serviceRoot, 'collect_licenses.py'), path.join(frozen, 'licenses')]);
  copy(frozen, path.join(stage, 'resources/acquisition'));
  copy(vendor, path.join(stage, 'resources/acquisition/vendor'));
  copy(path.join(desktop, 'dist'), path.join(stage, 'dist'));
  fs.mkdirSync(path.join(stage, 'electron'), { recursive: true });
  for (const file of fs.readdirSync(path.join(desktop, 'electron')))
    if (/^field-.*\.cjs$/.test(file) || ['local-auth.cjs', 'unified-auth.cjs'].includes(file))
      fs.copyFileSync(path.join(desktop, 'electron', file), path.join(stage, 'electron', file));
  const salt = randomBytes(32).toString('hex'), initial = randomBytes(15).toString('base64url');
  fs.writeFileSync(path.join(stage, 'electron/bootstrap-admin.json'), JSON.stringify({ version: 1, username: 'admin',
    salt, hash: scryptSync(initial, salt, 64).toString('hex') }), { mode: 0o600 });

  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  delete pkg.scripts; delete pkg.devDependencies;
  delete pkg.build.beforePack; delete pkg.build.win; delete pkg.build.nsis;
  Object.assign(pkg.build, { buildVersion: stamp.slice(0, 8) + '.' + stamp.slice(9, 15),
    directories: { output: path.join(work, 'release') }, electronDist: path.join(root, 'node_modules/electron/dist'),
    electronVersion: require('electron/package.json').version,
    extraResources: [{ from: 'resources/acquisition', to: 'acquisition', filter: ['**/*'] }],
    mac: { target: 'dir', category: 'public.app-category.productivity', identity: '-', hardenedRuntime: false } });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log('Packaging and signing app…');
  run(path.join(root, 'node_modules/.bin/electron-builder'), ['--projectDir', stage, '--mac', 'dir', '--arm64'],
    { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
  bundle = path.join(work, 'release/mac-arm64/BladeVMS.app');
  assertLocalLinks(bundle);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const resources = path.join(bundle, 'Contents/Resources'), archive = path.join(resources, 'app.asar');
  for (const name of fs.readdirSync(path.join(stage, 'electron')))
    assert.deepEqual(asar.extractFile(archive, `electron/${name}`), fs.readFileSync(path.join(stage, 'electron', name)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BLADE_|PYTHON|CONDA|VIRTUAL_ENV)/.test(key)));
  const sdkCheck = JSON.parse(run(path.join(resources, 'acquisition/BladeAcquisition'), ['--self-check'],
    { env: { ...env, BLADE_POLYTEC_DLL: path.join(resources, 'acquisition/vendor/libDeviceCommunication.dylib') } }));
  assert.ok(sdkCheck.frozen && sdkCheck.dllLoaded && sdkCheck.hardwareTouched === false);
  const { createFieldService } = require(path.join(stage, 'electron/field-service.cjs'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-package-service-'));
  const service = createFieldService({ getConfig: () => ({}), resourcesDir: resources, dataDir,
    servicesRoot: path.join(work, 'no-source'), environment: { PATH: '/usr/bin:/bin', PYTHONHOME: '/missing', PYTHONPATH: '/missing' } });
  try {
    const state = await service.start();
    assert.equal(state.service.state, 'ready', state.service.error);
    assert.equal(state.service.launcher, 'macos-bundle');
    assert.equal(state.service.dllConfigured, true);
    assert.equal(state.receiver.running, false);
  } finally { await service.shutdown({ force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); }

  const dmgContent = path.join(work, 'dmg');
  copy(bundle, path.join(dmgContent, 'BladeVMS.app'));
  fs.symlinkSync('/Applications', path.join(dmgContent, 'Applications'));
  const basename = `BladeVMS-${pkg.version}-mac-arm64-${stamp}`;
  const notes = `${basename}-安装与登录说明.txt`;
  fs.writeFileSync(path.join(dmgContent, notes), `BladeVMS ${pkg.version} · Apple Silicon（M 系列），macOS 13 及以上。\n\n将 BladeVMS.app 拖入 Applications。先退出旧客户端，避免同时连接设备。已内置采集服务、Python 环境和激光 SDK，无需安装 Python。\n\n首次使用：账号 admin，初始密码 ${initial}\n首次登录必须修改密码。已有本机账号继续使用自己的密码，不重置账号和记录。\n此包未包含开发者本机账号、绑定、采集数据和现场参数。设备网络、作业原点及校正系数按现场填写。\n\n本地测试包采用 ad-hoc 签名，未进行 Apple 公证。若 macOS 阻止首次打开，请在系统设置→隐私与安全性核对来源后选择仍要打开，无需关闭系统安全功能。\n`, { mode: 0o600 });
  console.log('Verifying DMG…');
  const dmg = path.join(work, `${basename}.dmg`);
  run('/usr/bin/hdiutil', ['create', '-volname', `BladeVMS ${pkg.version}`, '-srcfolder', dmgContent, '-format', 'UDZO', dmg]);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  fs.mkdirSync(output, { recursive: true });
  const delivered = path.join(output, path.basename(dmg));
  fs.copyFileSync(dmg, delivered, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(dmgContent, notes), path.join(output, notes), fs.constants.COPYFILE_EXCL);
  const sha256 = createHash('sha256').update(fs.readFileSync(delivered)).digest('hex');
  fs.writeFileSync(`${delivered}.sha256`, `${sha256}  ${path.basename(delivered)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(work, 'verification.json'), JSON.stringify({ version: pkg.version, buildVersion: pkg.build.buildVersion,
    platform: 'darwin', arch: 'arm64', sdkSymbols: sdkCheck.sdkSymbols, standaloneServiceReady: true,
    hardwareTouched: false, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    includesWorkingTree: true, delivered, sha256 }, null, 2));
  console.log(`Created ${delivered}\nInstall/login instructions: ${path.join(output, notes)}\nVerification/logs: ${work}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
