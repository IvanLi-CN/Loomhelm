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

test("identity actions follow the project name instead of filling the title row", () => {
  expect(css).toContain(".identity-copy { flex: 0 1 auto; min-width: 0; }");
  expect(css).toContain("text-overflow: ellipsis; white-space: nowrap;");
});

test("mobile theme entry shares the title row centerline", () => {
  expect(css).toContain(".topbar .theme-control { position: absolute; top: 12px; right: 16px; width: 44px; height: 44px; min-height: 44px; }");
});

test("compact header icons use optical rather than box-edge spacing", () => {
  expect(css).toContain(".run-profile-control { flex: 0 0 auto; min-width: 0; margin-left: -1px; }");
  expect(css).toContain("display: inline-flex; align-items: center; justify-content: center; width: 30px;");
  expect(css).toContain("width: 16px; height: 16px; flex: 0 0 16px; transform: translateX(-0.5px);");
});

test("mobile header actions use 44px touch targets and 18px icons", () => {
  expect(css).toContain(".topbar .plan-info-trigger { width: 44px; height: 44px; min-height: 44px; flex: 0 0 44px; margin-left: -8px; }");
  expect(css).toContain(".topbar .theme-control .theme-trigger { width: 44px; height: 44px; min-height: 44px;");
  expect(css).toContain(".run-profile-control { flex: 0 0 44px; width: 44px; margin-left: -8px; }");
  expect(css).toContain("width: 18px; height: 18px; flex: 0 0 18px;");
});
