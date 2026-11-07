import { describe, expect, test } from "bun:test";
import { formatLocalTime, fullLocalTime } from "../../web/time";
import { renderTimestamp, refreshTimestamps } from "../../web/timestamp";
import { renderStatusRow } from "../../web/status-row";

describe("local timestamps", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  test("uses the exact twelve-hour and seven-day boundaries", () => {
    expect(formatLocalTime(new Date(now - 12 * 3600000 + 1).toISOString(), now)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatLocalTime(new Date(now - 12 * 3600000).toISOString(), now)).toBe("12小时前");
    expect(formatLocalTime(new Date(now - 7 * 86400000 + 1).toISOString(), now)).toBe("6天前");
    expect(formatLocalTime(new Date(now - 7 * 86400000).toISOString(), now)).toMatch(/^10月29日 \d{2}:\d{2}$/);
  });
  test("shows absolute dates and seconds without a timezone label", () => {
    expect(fullLocalTime("2026-11-05T10:42:03Z")).toMatch(/^2026\/11\/05 \d{2}:42:03$/);
  });
  test("omits absent times and exposes a full absolute tooltip on focus", () => {
    expect(renderTimestamp(null).textContent).toBe("");
    const row = renderStatusRow({ name: "验收", status: "planned" });
    expect(row.querySelector("time")).toBeNull();
    document.body.replaceChildren(renderTimestamp("2026-11-05T10:42:03Z"));
    const time = document.querySelector("time")!;
    time.focus();
    expect(document.querySelector(".timestamp-tooltip.is-open")?.textContent).toBe(fullLocalTime(time.dateTime));
    expect(document.querySelector(".timestamp-tooltip")?.textContent).toContain("2026");
    time.textContent = "stale";
    refreshTimestamps();
    expect(time.textContent).not.toBe("stale");
  });
});
