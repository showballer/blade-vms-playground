const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalAuth } = require('./local-auth.cjs');
const { createFieldService, failure } = require('./field-service.cjs');
const { initialWindowBounds } = require('./field-window.cjs');

let win, auth, service, config = {}, quitting = false, closing = false;
let settingsFile, dataDir, entryUrl;
let mutation = Promise.resolve();
const serial = fn => {
  const work = mutation.then(fn, fn);
  mutation = work.catch(() => {});
  return work;
};
function trusted(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url.split('#')[0] !== entryUrl) throw failure('不可信窗口', 403);
}
function persistConfig(next) {
  const temp = settingsFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temp, settingsFile); config = next;
}
async function idleRequired() {
  const status = await service.status();
  if (status.receiver?.running || ['starting', 'acquiring', 'stopping'].includes(status.state)) throw failure('请先停止采集并确认保存，再修改服务设置或退出登录', 409);
  if (status.service.error && status.service.state === 'ready') throw failure('服务状态未知，请先停止采集或关闭软件检查数据，不能直接替换正在运行的服务', 409);
}
async function chooseProgram(kind) {
  await idleRequired();
  const isDll = kind === 'dll';
  const selected = await dialog.showOpenDialog(win, {
    title: isDll ? '选择厂商 Windows x64 DeviceCommunication.dll' : '选择已联调的 Windows x64 BladeAcquisition.exe（保留其完整依赖目录）',
    properties: ['openFile'], filters: [{ name: isDll ? '设备 SDK' : 'Python 采集服务', extensions: [isDll ? 'dll' : 'exe'] }],
  });
  if (selected.canceled || selected.filePaths.length !== 1) return { canceled: true };
  const file = selected.filePaths[0];
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== (isDll ? '.dll' : '.exe') || !fs.statSync(file).isFile()) throw failure('所选文件类型无效', 400);
  if (!isDll) {
    const consent = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '信任并使用'], defaultId: 0, cancelId: 0,
      message: '此操作会在本机运行所选采集服务', detail: `只选择项目同事交付且已验证来源的服务程序。\n${file}` });
    if (consent.response !== 1) return { canceled: true };
  }
  if (service.serviceInfo().state === 'ready') await service.shutdown();
  else await service.shutdown({ force: true });
  persistConfig({ ...config, [kind]: file });
  return service.start();
}
async function dispatch(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.action !== 'string') throw failure('无效操作', 400);
  const action = options.action;
  if (closing && !['session', 'status', 'frame'].includes(action)) throw failure('正在安全退出，请等待或取消退出后重试', 409);
  if (action === 'session') return auth.session();
  if (action === 'login') return auth.login(options.username, options.password);
  if (action === 'changePassword') return auth.changePassword(options.currentPassword, options.newPassword);
  if (action === 'logout') {
    auth.requireSession({ allowInitial: true });
    await idleRequired(); return auth.logout();
  }
  auth.requireSession();
  switch (action) {
    case 'status': return service.status();
    case 'frame': return service.frame();
    case 'start': return service.begin(options.config);
    case 'stop': return service.stop();
    case 'recordings': return service.recordings();
    case 'recording': return service.recordings(options.id);
    case 'configureService': return chooseProgram('executable');
    case 'configureDll': return chooseProgram('dll');
    case 'restartService':
      await idleRequired();
      if (service.serviceInfo().state === 'ready') await service.shutdown();
      else await service.shutdown({ force: true });
      return service.start();
    case 'openDataDirectory': {
      const result = await shell.openPath(dataDir);
      if (result) throw failure('无法打开本机采集数据目录：' + result);
      return { opened: true };
    }
    default: throw failure('不支持此操作', 400);
  }
}
async function closeSafely() {
  if (quitting || closing) return;
  closing = true;
  try {
    // Serialize against acquisition start/configuration so close cannot race a
    // successful start and leave a hardware-owning process without a UI.
    await serial(async () => {
      const snapshot = await service.status();
      if (snapshot.receiver?.running || ['starting', 'acquiring', 'stopping'].includes(snapshot.state)) {
        const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['继续采集', '停止保存并退出'], defaultId: 0, cancelId: 0,
          message: '正在采集，是否停止并保存后退出？' });
        if (answer.response !== 1) return;
      }
      try { await service.shutdown(); }
      catch {
        const answer = await dialog.showMessageBox(win, { type: 'warning', buttons: ['返回检查', '退出并保留未完成数据'], defaultId: 0, cancelId: 0,
          message: '无法确认本次采集已完整保存', detail: '服务可能已异常。强制退出后请检查本机数据目录里的 incomplete/error 记录；不要将其当作完整采集。' });
        if (answer.response !== 1) return;
        await service.shutdown({ force: true });
      }
      auth?.logout(); quitting = true; app.quit();
    });
  } catch {
    await dialog.showMessageBox(win, { type: 'error', buttons: ['返回检查'],
      message: '未能安全退出采集服务，软件尚未关闭',
      detail: '请确认设备激光状态，并在 Windows 检查采集服务进程和本机未完成数据后重试。' });
  } finally { closing = false; }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    settingsFile = path.join(userData, 'blade-field-settings.json');
    dataDir = path.join(userData, 'field-data');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            ['executable', 'dll'].some(key => config[key] !== undefined && (typeof config[key] !== 'string' || !path.isAbsolute(config[key])))) throw Error('配置格式无效');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      auth = createLocalAuth({ file: path.join(userData, 'blade-local-auth.json'), bootstrap: require('./bootstrap-admin.json') });
      service = createFieldService({ getConfig: () => config, dataDir,
        resourcesDir: app.isPackaged ? process.resourcesPath : path.join(__dirname, '../resources') });
    } catch {
      dialog.showErrorBox('无法打开现场工作台', '本机凭证、设置或数据目录不可用。未覆盖已有数据、未重置管理员密码。请检查用户目录权限和文件完整性。');
      quitting = true; app.quit(); return;
    }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win = new BrowserWindow({ ...initialWindowBounds(workArea),
      title: 'BladeVMS 现场采集工作台', frame: false, backgroundColor: '#F5F7FA',
      webPreferences: { preload: path.join(__dirname, 'field-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    entryUrl = process.env.BLADE_DEV_URL === 'http://127.0.0.1:5210'
      ? 'http://127.0.0.1:5210/' : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== entryUrl) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.on('close', event => { if (!quitting) { event.preventDefault(); void closeSafely(); } });
    ipcMain.handle('blade:field', async (event, options) => {
      try {
        trusted(event);
        const execute = () => dispatch(options);
        const result = ['session', 'status', 'frame', 'recordings', 'recording'].includes(options?.action)
          ? await execute() : await serial(execute);
        return { status: 200, data: result };
      } catch (error) { return { status: error.status || 500, data: { error: error.message || '本机操作失败' } }; }
    });
    ipcMain.on('blade:field-window', (event, action) => {
      try {
        trusted(event);
        if (action === 'minimize') win.minimize();
        if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
        if (action === 'close') win.close();
      } catch { /* Reject messages from an untrusted sender. */ }
    });
    void service.start().catch(() => {}); // Starts idle; never connects the device.
    void win.loadURL(entryUrl);
  });
  app.on('before-quit', event => { if (!quitting && service) { event.preventDefault(); void closeSafely(); } });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
