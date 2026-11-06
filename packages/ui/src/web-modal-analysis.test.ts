import assert from 'node:assert/strict';
import { webModalRequest } from './web-modal-analysis';

async function main() {
  const originalFetch = globalThis.fetch;
  const sent: any[] = [];
  let replies: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/measurements/formal-modal');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.method, 'POST');
    sent.push(JSON.parse(String(options?.body)));
    const next = replies.shift();
    assert(next, 'unexpected request');
    return new Response(JSON.stringify(next), { status: 200 });
  };
  const call = (operation: string, parameters = {}) => webModalRequest<any>({ action: 'formalModal', request: { operation, parameters } } as any);
  try {
    replies = [{ datasets: [{ id: 'source' }], jobs: [] }];
    assert.equal((await call('catalog')).datasets[0].id, 'source');
    replies = [{ channels: [], time_s: [] }];
    await call('preview', { datasetId: 'source' });
    assert.deepEqual(sent.at(-1), { action: 'preview', datasetId: 'source' });
    replies = [{ id: 'job', status: 'running' }, { id: 'job', status: 'complete', result: { modes: [{ naturalFrequencyHz: 2 }] } }];
    const completed = await call('start', { datasetId: 'source', method: 'decay' });
    assert.deepEqual(sent.at(-1), { action: 'status', id: 'job' });
    assert.equal(completed.job.id, 'job');
    assert.equal(completed.result.modes[0].naturalFrequencyHz, 2);
    replies = [{ id: 'saved', status: 'complete', result: { modes: [] } }];
    assert.equal((await call('result', { jobId: 'saved' })).job.id, 'saved');
    assert.deepEqual(sent.at(-1), { action: 'result', id: 'saved' });
    replies = [{ id: 'bad', status: 'failed', error: '输入缺少同步通道' }];
    await assert.rejects(call('start'), /输入缺少同步通道/);
    const count = sent.length;
    await assert.rejects(webModalRequest({ action: 'captureStart' } as any), /仅支持模态分析/);
    assert.equal(sent.length, count, 'unsupported action never reaches API');
    console.log('PASS Web modal bridge preview, async result, history mapping and failure propagation');
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
