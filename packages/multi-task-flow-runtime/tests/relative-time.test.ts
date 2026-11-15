import { describe, expect, test } from "bun:test";
import { formatRelativeHours } from "../web/relative-time";

describe("relative theoretical schedule labels", () => {
  test("formats offsets as hours from zero without a T prefix", () => {
    expect(formatRelativeHours(0)).toBe("0h");
    expect(formatRelativeHours(240)).toBe("4h");
    expect(formatRelativeHours(690)).toBe("11.50h");
    expect(formatRelativeHours(0)).not.toContain("T");
  });

  test("keeps missing offsets empty", () => {
    expect(formatRelativeHours(null)).toBe("");
    expect(formatRelativeHours(undefined)).toBe("");
  });
});
