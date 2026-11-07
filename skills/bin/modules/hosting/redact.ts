const SENSITIVE_KEY =
  /(?:token|authorization|password|passwd|secret|cookie|credential|api[_-]?key|private[_-]?key)/i;

export function redactProviderValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value))
    return value.map((item) => redactProviderValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactProviderValue(child, childKey),
      ]),
    );
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      for (const name of url.searchParams.keys())
        if (SENSITIVE_KEY.test(name)) url.searchParams.set(name, "[REDACTED]");
      return url.toString();
    } catch {
      return value;
    }
  }
  return value;
}
