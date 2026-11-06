import { describe, expect, test } from "bun:test";
import { deriveConnectionStatus } from "../../web/model";

describe("dashboard connection status", () => {
  test("keeps an unwatched snapshot stale even while a refresh is in flight", () => {
    expect(deriveConnectionStatus(false, false)).toBe("stale");
    expect(deriveConnectionStatus(true, false)).toBe("stale");
  });

  test("distinguishes a healthy stream from a connection that is still opening", () => {
    expect(deriveConnectionStatus(false, true)).toBe("connecting");
    expect(deriveConnectionStatus(true, true)).toBe("live");
  });
});
