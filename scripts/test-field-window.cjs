const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initialWindowBounds } = require('../apps/desktop/electron/field-window.cjs');

test('initial window fits work area including scaled, short and secondary displays', () => {
  for (const area of [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 0, y: 0, width: 1366, height: 728 },
    { x: 0, y: 0, width: 853, height: 453 },
    { x: -1280, y: 40, width: 1280, height: 680 },
    { x: 0, y: 0, width: 640, height: 400 },
  ]) {
    const result = initialWindowBounds(area);
    assert.ok(result.x >= area.x && result.y >= area.y);
    assert.ok(result.x + result.width <= area.x + area.width);
    assert.ok(result.y + result.height <= area.y + area.height);
    assert.ok(result.minWidth <= result.width && result.minHeight <= result.height);
  }
});
test('large screens keep the intended size and invalid display data is rejected', () => {
  assert.deepEqual(initialWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }),
    { width: 1520, height: 1000, minWidth: 760, minHeight: 480, x: 200, y: 40 });
  for (const area of [null, {}, { x: 0, y: 0, width: 0, height: 900 }]) assert.throws(() => initialWindowBounds(area));
});
