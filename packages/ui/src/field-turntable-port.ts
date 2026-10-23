// Keep COM identifiers canonical without changing case-sensitive macOS paths.
export function normalizeTurntablePort(value: string): string {
  const port = value.trim();
  return /^com[1-9][0-9]{0,3}$/i.test(port) ? port.toUpperCase() : port;
}

export function isTurntablePort(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() &&
    (/^(?:COM[1-9][0-9]{0,3}|\/dev\/cu\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.test(value) || isTurntableTcpEndpoint(value));
}

export function isTurntableTcpEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const match = /^tcp:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return false;
  const octets = match[1].split(".");
  return octets.every(item => Number(item) <= 255 && String(Number(item)) === item) &&
    Number(octets[0]) < 224 && octets.some(item => Number(item) > 0);
}

export const turntableConnectionKey = "blade-turntable-connection-v1";
export function readSavedTurntableConnection(raw: string | null): string {
  try { const value = JSON.parse(raw || "null"); return value?.version === 1 && isTurntablePort(value.endpoint) ? value.endpoint : ""; }
  catch { return ""; }
}
