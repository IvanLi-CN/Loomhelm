import { describe, expect, test } from "bun:test";
import { defaultTimelineWindow } from "../../web/timeline-window";

describe("dashboard timeline window", () => {
  test("fits a timeline containing only a milestone", () => {
    const window = defaultTimelineWindow([{ start: "2026-10-31T12:00:00.000Z" }]);
    expect(window.start?.getTime()).toBeLessThan(Date.parse("2026-10-31T12:00:00.000Z"));
    expect(window.end?.getTime()).toBeGreaterThan(Date.parse("2026-10-31T12:00:00.000Z"));
  });

  test("ignores unknown timestamps without losing known entries", () => {
    const window = defaultTimelineWindow([{ start: "not-a-date" }, { start: "2026-10-31T12:00:00.000Z", end: null }]);
    expect(window.start).toBeInstanceOf(Date);
    expect(window.end).toBeInstanceOf(Date);
  });
});
