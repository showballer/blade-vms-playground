'use strict';

// A local in-memory protocol peer for the shipped cloud-sync module. It never
// contacts a remote service and verifies every uploaded byte against disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function createHarness({ moduleFile, directory, recordingsDir, getLive }) {
  const { createFieldCloudSync } = require(moduleFile);
  const identity = { serverUrl: 'https://capture-release.invalid', user: { id: 'release-test', tenant: 'release-test' } };
  const token = randomBytes(32).toString('hex');
  const captures = new Map();
  const json = value => new Response(JSON.stringify(value));
  const queueFile = path.join(directory, 'test-cloud-queue.json');
  const queue = createFieldCloudSync({ file: queueFile, dataDir: recordingsDir, getLive, intervalMs: 60000,
    auth: { cloudBinding: () => identity, cloudSession: () => ({ ...identity, token }), clearCloudSession() { throw Error('Unexpected auth failure'); } },
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, identity.serverUrl);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.ok(parsed.pathname.startsWith('/api/v1/captures'));
      const route = parsed.pathname.slice('/api/v1/captures'.length);
      const body = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : null;
      if (!route) {
        const id = body.recording.id;
        if (!captures.has(id)) captures.set(id, { files: [], bytes: {}, live: [], complete: false });
        return json({ capture: { id } });
      }
      const [id, action, name] = route.slice(1).split('/');
      const capture = captures.get(id); assert.ok(capture, 'Capture must register first');
      if (action === 'live') {
        assert.ok(body.waveform.values.length > 0 && body.waveform.values.length <= 2048);
        capture.live.push(body); return json({ ok: true, sequence: body.sequence });
      }
      if (action === 'upload') {
        capture.files = body.files;
        return json({ capture: { id }, received: [], offsets: Object.fromEntries(body.files.map(file => [file.name, capture.bytes[file.name]?.length || 0])) });
      }
      if (action === 'chunks') {
        const previous = capture.bytes[name] || Buffer.alloc(0);
        assert.equal(Number(parsed.searchParams.get('offset')), previous.length);
        capture.bytes[name] = Buffer.concat([previous, Buffer.from(options.body)]);
        return json({ ok: true, nextOffset: capture.bytes[name].length, complete: capture.bytes[name].length === capture.files.find(file => file.name === name).bytes });
      }
      if (action === 'complete') {
        for (const file of capture.files) {
          assert.equal(capture.bytes[file.name].length, file.bytes);
          assert.equal(sha256(capture.bytes[file.name]), file.sha256);
          assert.deepEqual(capture.bytes[file.name], fs.readFileSync(path.join(recordingsDir, id, file.name)));
        }
        capture.complete = true;
        return json({ capture: { id, uploadState: 'complete' } });
      }
      throw Error(`Unexpected cloud action: ${action}`);
    },
  });
  return { queue, captures, assertSynced(id) {
    const capture = captures.get(id);
    assert.ok(capture.live.length > 0, 'Live preview must precede completed raw upload');
    assert.ok(capture.live.some(frame => frame.realtime?.spectrum?.amplitudes?.length > 0), 'Live FFT must reach cloud protocol');
    assert.equal(capture.complete, true);
    assert.equal(queue.status().items.find(item => item.recordingId === id).state, 'synced');
    assert.ok(!fs.readFileSync(queueFile, 'utf8').includes(token), 'Cloud session must not persist');
    return { liveFrames: capture.live.length, rawFilesMatched: capture.files.length, completeAcknowledged: true, tokenNotPersisted: true };
  } };
}
module.exports = { createHarness };
