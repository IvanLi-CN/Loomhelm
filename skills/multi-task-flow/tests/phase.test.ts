import { describe, expect, test } from "bun:test";
import { defaultTabForPhase, derivePhase } from "../web/phase";

describe("dashboard display phase", () => {
  test("stays in planning until a real task start fact exists", () => {
    expect(derivePhase([{ started_at: null }, { started_at: null }])).toBe("planning");
    expect(defaultTabForPhase("planning")).toBe("graph");
  });

  test("becomes execution monotonically when any task has started", () => {
    expect(derivePhase([{ started_at: null }, { started_at: "2026-01-01T00:00:00.000Z" }])).toBe("execution");
    expect(defaultTabForPhase("execution")).toBe("actual");
  });
});
