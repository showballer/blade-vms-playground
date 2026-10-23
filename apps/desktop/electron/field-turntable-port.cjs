"use strict";

// Match the renderer and Python boundary. Real device availability is checked
// by the acquisition process before opening a serial adapter or TCP endpoint.
function isTurntablePort(value) {
  return typeof value === "string" && value === value.trim() &&
    (/^(?:COM[1-9][0-9]{0,3}|\/dev\/cu\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.test(value) || isTurntableTcpEndpoint(value));
}

function isTurntableTcpEndpoint(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const match = /^tcp:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return false;
  const octets = match[1].split('.');
  return octets.every(item => Number(item) <= 255 && String(Number(item)) === item) &&
    Number(octets[0]) < 224 && octets.some(item => Number(item) > 0);
}

module.exports = { isTurntablePort, isTurntableTcpEndpoint };
