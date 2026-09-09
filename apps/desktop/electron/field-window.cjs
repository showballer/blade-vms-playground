// Electron workArea uses device-independent pixels, so this also respects
// Windows display scaling and the taskbar instead of assuming physical pixels.
function initialWindowBounds(area) {
  if (!area || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(area[key])) || area.width <= 0 || area.height <= 0) {
    throw new Error('Invalid display work area');
  }
  const width = Math.max(1, Math.min(1520, Math.floor(area.width)));
  const height = Math.max(1, Math.min(1000, Math.floor(area.height)));
  return { width, height, minWidth: Math.min(760, width), minHeight: Math.min(480, height),
    x: Math.floor(area.x + (area.width - width) / 2), y: Math.floor(area.y + (area.height - height) / 2) };
}
module.exports = { initialWindowBounds };
