'use strict';

// Explicit package-only module graph. Never load sibling modules from the
// workspace to make an incomplete Windows payload appear to pass acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MODULES = Object.freeze(['field-service.cjs', 'field-turntable-port.cjs', 'field-sdk.cjs',
  'field-single-point.cjs', 'field-motion-trial.cjs', 'field-cloud-sync.cjs', 'field-recording-name.cjs']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function extractPackagedBridge({ archive, directory, sourceDirectory, asar = require('@electron/asar') }) {
  const hashes = {};
  fs.mkdirSync(directory, { recursive: true });
  for (const name of MODULES) {
    const bytes = asar.extractFile(archive, `electron/${name}`);
    hashes[name] = sha256(bytes);
    assert.equal(hashes[name], sha256(fs.readFileSync(path.join(sourceDirectory, name))),
      `Packaged ${name} must match this release source`);
    fs.writeFileSync(path.join(directory, name), bytes);
  }
  return { bridgeFile: path.join(directory, 'field-service.cjs'),
    cloudFile: path.join(directory, 'field-cloud-sync.cjs'), hashes };
}

module.exports = { extractPackagedBridge, MODULES };
