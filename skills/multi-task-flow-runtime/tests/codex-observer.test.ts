import { describe, expect, test } from "bun:test";
import { framePayload, websocketFrame } from "../lib/codex-socket";

describe("Codex socket framing", () => {
  test("decodes masked frames across all length encodings without consuming the next frame", () => {
    for (const size of [0, 125, 126, 65535, 65536]) {
      const text = "a".repeat(size);
      const frame = websocketFrame(text);
      const result = framePayload(Buffer.concat([frame, websocketFrame("next")]));
      expect(result?.payload.toString()).toBe(text);
      expect(result?.consumed).toBe(frame.length);
      expect(framePayload(frame.subarray(0, frame.length - 1))).toBeNull();
    }
  });
  test("preserves raw ping/pong payload bytes and opcode", () => {
    const bytes = Buffer.from([0xff, 0x00, 0x81]);
    const frame = websocketFrame(bytes, 10);
    expect(frame[0]! & 15).toBe(10);
    expect(framePayload(frame)?.payload).toEqual(bytes);
  });
  test("rejects oversized input before buffering the declared payload", () => {
    const frame = Buffer.alloc(10); frame[0] = 0x81; frame[1] = 127; frame.writeBigUInt64BE(65n * 1024n * 1024n, 2);
    expect(() => framePayload(frame)).toThrow("limit");
  });
});
