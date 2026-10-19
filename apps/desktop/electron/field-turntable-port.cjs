"use strict";

// Match the renderer and Python boundary. Real device availability is checked
// by the acquisition process immediately before opening the serial adapter.
function isTurntablePort(value) {
  return typeof value === "string" && value === value.trim() &&
    /^(?:COM[1-9][0-9]{0,3}|\/dev\/cu\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.test(value);
}

module.exports = { isTurntablePort };
