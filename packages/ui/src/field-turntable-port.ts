// Keep COM identifiers canonical without changing case-sensitive macOS paths.
export function normalizeTurntablePort(value: string): string {
  const port = value.trim();
  return /^com[1-9][0-9]{0,3}$/i.test(port) ? port.toUpperCase() : port;
}

export function isTurntablePort(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() &&
    /^(?:COM[1-9][0-9]{0,3}|\/dev\/cu\.[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.test(value);
}
