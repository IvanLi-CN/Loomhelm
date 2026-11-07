import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../../web/app.css", import.meta.url), "utf8");

test("medium layout shares container-derived card tracks across detail states", () => {
  const medium = css.split("@media (min-width: 768px) and (max-width: 1444px) {")[1]!.split("@media (max-width: 767px)")[0]!;
  expect(medium).toContain("container-type: inline-size");
  expect(medium).toContain("round(down, calc((100cqw + 20px) / 263px), 1)");
  expect(medium).toContain("repeat(auto-fill, var(--stable-task-card-width))");
  expect(medium).not.toContain("minmax(243px, 1fr)");
});
