'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareBundledRecordings } = require('../apps/desktop/electron/field-bundled-recordings.cjs');
const root = path.resolve(__dirname, '..');
const python = process.env.BLADE_BUILD_PYTHON || path.join(root, 'services/acquisition/.venv-build', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const output = path.join(root, 'apps/desktop/resources/bundled-recordings');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-package-tasks-'));
try {
  const source = path.join(work, 'source'), ready = path.join(work, 'ready');
  execFileSync(python, [path.join(root, 'scripts/prepare-windows-task-data.py'), source], { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(ready);
  const tasks = JSON.parse(fs.readFileSync(path.join(source, 'tasks.json'), 'utf8')).map(task => {
    const summary = prepareBundledRecordings({ recordingsDir: path.join(source, task.directory, 'recordings'), taskName: task.taskName, outputDir: path.join(ready, task.directory) });
    return { ...task, bundleId: summary.bundleId };
  });
  fs.cpSync(path.join(source, 'reference-data'), path.join(ready, 'reference-data'), { recursive: true });
  fs.writeFileSync(path.join(ready, 'catalog.json'), JSON.stringify({ schemaVersion: 1, tasks }, null, 2) + '\n');
  fs.writeFileSync(path.join(ready, 'README.txt'), '首次启动自动导入三组任务，共 180 条记录、9 片叶片。登录后从“本机记录 → 叶片采集任务”或“叶片响应分析”选择任务。重启不会重复导入；删除的预置记录不会自动恢复；已有同编号记录保留。\nreference-data 中附带风场工况与武川参考配置，保持原有时间口径。Web 风场数据集仍通过 Web 管理。\n');
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(ready, output, { recursive: true });
  console.log(JSON.stringify({ tasks: tasks.map(t => t.taskName), recordings: tasks.reduce((n, t) => n + t.recordCount, 0), output }));
} finally { fs.rmSync(work, { recursive: true, force: true }); }
