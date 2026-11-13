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

test("medium details stay in the static bottom layout instead of a side-by-side column", () => {
  const medium = css.split("@media (min-width: 768px) and (max-width: 1444px) {")[1]!.split("@media (max-width: 767px)")[0]!;
  expect(medium).toContain(".workspace.has-details, .workspace.has-overlay-selection { grid-template-columns: minmax(0, 1fr); }");
  expect(medium).toContain(".details { position: static; width: auto;");
  expect(medium).toContain("border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent;");
  expect(medium).toContain(".details-heading button { display: none; }");
  expect(medium).toContain(".details-slot { position: static; padding-top: 16px; }");
  expect(medium).toContain(".details-heading { padding: 0 0 12px; display: flex; align-items: baseline;");
  expect(medium).toContain("#details-content { padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));");
  expect(medium).toContain("grid-auto-rows: max-content; align-content: start; align-items: start;");
  expect(medium).toContain("#details-content[data-detail-kind=\"task\"] { grid-template-columns: minmax(220px, .9fr) repeat(3, minmax(0, 1fr)); }");
  expect(medium).toContain("#details-content[data-detail-kind=\"group\"] { grid-template-columns: minmax(260px, 1.25fr) repeat(3, minmax(0, 1fr)); }");
  expect(medium).toContain("#details-content > .detail-field:has(.atom-list) { grid-column: span 1; }");
  expect(medium).toContain("#details-content > .detail-field:has(.atom-list) { display: block; }");
  expect(medium).toContain("text-overflow: ellipsis; white-space: nowrap;");
  expect(medium).toContain("#details-content > .detail-group-facts { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
  expect(medium).toContain("#details-content > .detail-group-facts > .detail-field { min-width: 0; padding-block: 7px; display: block; }");
  expect(medium).toContain('.workspace[data-view-tab="tasks"] .details-slot { grid-column: 1; grid-row: 3; }');
});

test("tall medium details provide an independently scrollable content body", () => {
  const tall = css.split("@media (min-width: 768px) and (max-width: 1444px) and (min-height: 961px) {")[1]!.split("@media (min-width: 768px) and (max-width: 1444px) and (max-height: 960px)")[0]!;
  expect(tall).toContain("display: flex; flex-direction: column;");
  expect(tall).toContain("#details-content { flex: 1 1 auto; min-height: 0; overflow: auto; }");
  expect(tall).toContain(".workspace-view > .timeline-view { min-height: 0; display: flex; flex-direction: column; }");
  expect(tall).toContain("height: auto !important; min-height: 0;");
  expect(tall).toContain("overflow-anchor: none;");
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
