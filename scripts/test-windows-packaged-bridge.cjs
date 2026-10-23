'use strict';

// Module loading only: no frozen program, service, credentials, network or device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { test } = require('node:test');
const asar = require('@electron/asar');
const { extractPackagedBridge, MODULES } = require('./windows-packaged-bridge.cjs');
const sourceDirectory = path.resolve(__dirname, '../apps/desktop/electron');

test('packaged bridge loads its own complete relative module graph, with source hashes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-packaged-module-test-'));
  try {
    const packaged = path.join(directory, 'package'), extracted = path.join(directory, 'extracted');
    fs.mkdirSync(path.join(packaged, 'electron'), { recursive: true });
    for (const name of MODULES) fs.copyFileSync(path.join(sourceDirectory, name), path.join(packaged, 'electron', name));
    const archive = path.join(directory, 'app.asar');
    const writing = await asar.createPackage(packaged, archive);
    // This asar version resolves with out.end() before the writable's finish.
    // Wait for actual bytes before checking hashes, including under test load.
    if (writing?.once) await finished(writing);
    const value = extractPackagedBridge({ archive, directory: extracted, sourceDirectory });
    assert.equal(typeof require(value.bridgeFile).createFieldService, 'function');
    assert.equal(typeof require(value.cloudFile).createFieldCloudSync, 'function');
    assert.deepEqual(fs.readdirSync(extracted).sort(), [...MODULES].sort());
    assert.equal(Object.keys(value.hashes).length, MODULES.length);
    assert.ok(Object.values(value.hashes).every(hash => /^[0-9a-f]{64}$/.test(hash)));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing packaged dependencies cannot fall back to available source modules', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-missing-module-test-'));
  const requested = [];
  try {
    assert.throws(() => extractPackagedBridge({ archive: 'fixture-only', directory, sourceDirectory,
      asar: { extractFile(_archive, name) {
        requested.push(name);
        if (name.endsWith('/field-turntable-port.cjs')) throw Error('packaged dependency missing');
        return fs.readFileSync(path.join(sourceDirectory, path.basename(name)));
      } },
    }), /packaged dependency missing/);
    assert.deepEqual(requested, ['electron/field-service.cjs', 'electron/field-turntable-port.cjs']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('changed packaged modules fail instead of silently using current workspace code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-stale-module-test-'));
  try {
    assert.throws(() => extractPackagedBridge({ archive: 'fixture-only', directory, sourceDirectory,
      asar: { extractFile: () => Buffer.from('module.exports = {};\n') },
    }), /Packaged field-service.cjs must match this release source/);
    assert.equal(fs.readdirSync(directory).length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
