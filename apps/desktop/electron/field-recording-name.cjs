// Keep user names separate from diagnostic metadata, including legacy uploads.
function normalizeRecordingName(record) {
  if (typeof record.originalTaskName === 'string') return { ...record, name: record.originalTaskName };
  const suffix = ' [未停稳判定测试]';
  if (record.diagnosticOnly === true && record.pointCycle?.diagnosticDetection?.enabled === true &&
      typeof record.name === 'string' && record.name.endsWith(suffix)) {
    const name = record.name.slice(0, -suffix.length);
    return { ...record, name, originalTaskName: name };
  }
  return record;
}
module.exports = { normalizeRecordingName };
