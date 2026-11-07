import { Runtime } from "./runtime";
export class InputEncodingError extends Error {
  constructor() {
    super("input is not valid UTF-8");
    this.name = "InputEncodingError";
  }
}

export function assertUtf8Text(value: string): void {
  try {
    encodeURIComponent(value);
  } catch {
    throw new InputEncodingError();
  }
}

export async function readStdinUtf8(signal?: AbortSignal): Promise<string> {
  const reader = Runtime.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new Error("stdin read aborted");
    const readAll = async (): Promise<Uint8Array[]> => {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value) chunks.push(result.value);
      }
      return chunks;
    };
    const bytes = signal
      ? await Promise.race([
          readAll(),
          new Promise<never>((_, reject) => {
            onAbort = () => {
              void reader.cancel();
              reject(new Error("stdin read aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : await readAll();
    const length = bytes.reduce((total, chunk) => total + chunk.length, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of bytes) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(joined);
    } catch {
      throw new InputEncodingError();
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
