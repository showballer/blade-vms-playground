'use strict';

const fs = require('node:fs');
const path = require('node:path');

const actions = new Set(['catalog', 'start', 'status', 'result', 'preview', 'extended', 'export', 'cancel', 'inspect','contract','review','review_history','package','sync','sync_status','publish']);
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }

function recordAnalysisRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !actions.has(request.action) ||
      JSON.stringify(request).length > 64000) throw invalid('无效记录分析请求');
  // Files are resolved by the local service from recording/job IDs only.
  if (['path', 'file', 'directory', 'outputPath', 'dataDir'].some(key => key in request))
    throw invalid('记录分析仅接受已保存的记录编号');
  if(['inspect','review_history'].includes(request.action)){if(typeof request.recordingId!=='string'||!/^[0-9a-f]{32}$/.test(request.recordingId))throw invalid('请选择有效原始记录');return request;}
  if (request.action === 'start') {
    if (!Array.isArray(request.recordingIds) || request.recordingIds.length < 1 || request.recordingIds.length > 200 ||
        request.recordingIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) ||
        new Set(request.recordingIds).size !== request.recordingIds.length ||
        !['analysis', 'formal', 'diagnostic'].includes(request.scope) || !['LOS_DIAGNOSTIC', 'RAW_REVIEW'].includes(request.profile))
      throw invalid('请选择有效的任务记录、结果集合和分析配置');
  } else if (!['catalog','contract','sync_status'].includes(request.action) &&
      (typeof request.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.jobId))) {
    throw invalid('记录分析任务编号无效');
  }
  if (request.action === 'export' && !['analysis', 'summary', 'preview', 'raw'].includes(request.kind))
    throw invalid('请选择有效的分析导出类型');
  return request;
}

async function recordAnalysisExportFile(dataDir, jobId, result) {
  if (!result || typeof result.path !== 'string' || !path.isAbsolute(result.path) ||
      typeof result.fileName !== 'string' || result.fileName !== path.basename(result.fileName) ||
      /[<>:"/\\|?*\x00-\x1f]/.test(result.fileName)) throw invalid('分析导出文件无效');
  const expected = path.join(await fs.promises.realpath(dataDir), 'record-analysis-v1', jobId, 'exports');
  const base = await fs.promises.realpath(expected);
  const file = await fs.promises.realpath(result.path);
  if (base !== path.resolve(expected) || path.dirname(file) !== base || path.basename(file) !== result.fileName ||
      !(await fs.promises.stat(file)).isFile()) throw invalid('分析导出文件不在本次分析缓存内');
  return file;
}

module.exports = { recordAnalysisRequest, recordAnalysisExportFile };
