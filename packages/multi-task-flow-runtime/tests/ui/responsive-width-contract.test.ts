import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/app.css", import.meta.url), "utf8");

test("medium layout shares container-derived card tracks across detail states", () => {
  const medium = css
    .split("@media (min-width: 768px) and (max-width: 1444px) {")[1]!
    .split("@media (max-width: 767px)")[0]!;
  expect(medium).toContain("container-type: inline-size");
  expect(medium).toContain("round(down, calc((100cqw + 20px) / 263px), 1)");
  expect(medium).toContain("repeat(auto-fill, var(--stable-task-card-width))");
  expect(medium).not.toContain("minmax(243px, 1fr)");
});

test("medium details stay in the static bottom layout instead of a side-by-side column", () => {
  const medium = css
    .split("@media (min-width: 768px) and (max-width: 1444px) {")[1]!
    .split("@media (max-width: 767px)")[0]!;
  expect(medium).toContain(
    ".workspace.has-details, .workspace.has-overlay-selection { grid-template-columns: minmax(0, 1fr); }",
  );
  expect(medium).toContain(".details { position: static; width: auto;");
  expect(medium).toContain(
    "border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent;",
  );
  expect(medium).toContain(".details-heading button { display: none; }");
  expect(medium).toContain(".details-slot { position: static; padding-top: 16px; }");
  expect(medium).toContain(
    ".details-heading { padding: 0 0 12px; display: flex; align-items: center;",
  );
  expect(medium).toContain(
    "#details-summary { min-width: 0; display: flex; align-items: center; gap: 12px; }",
  );
  expect(medium).toContain(
    ".detail-title { min-width: 0; margin: 0; padding-right: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  );
  expect(medium).toContain(".detail-state { flex: 0 0 auto; margin: 0; white-space: nowrap; }");
  expect(medium).toContain(
    "#details-content { padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));",
  );
  expect(medium).toContain(
    "grid-auto-rows: max-content; align-content: start; align-items: start;",
  );
  expect(medium).toContain(
    '#details-content[data-detail-kind="task"] { grid-template-columns: minmax(220px, .9fr) repeat(3, minmax(0, 1fr)); }',
  );
  expect(medium).toContain(
    '#details-content[data-detail-kind="group"] { grid-template-columns: minmax(260px, 1.25fr) repeat(3, minmax(0, 1fr)); }',
  );
  expect(medium).toContain(
    "#details-content > .detail-field:has(.atom-list) { grid-column: span 1; }",
  );
  expect(medium).toContain(
    "#details-content > .detail-field:has(.atom-list) { display: block; padding-block: 7px; }",
  );
  expect(medium).toContain("text-overflow: ellipsis; white-space: nowrap;");
  expect(medium).toContain(
    "#details-content > .detail-group-facts { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));",
  );
  expect(medium).toContain(
    "#details-content > .detail-group-facts > .detail-field { min-width: 0; padding-block: 7px; display: block; }",
  );
  expect(medium).toContain(
    '.workspace[data-view-tab="tasks"] .details-slot { grid-column: 1; grid-row: 3; }',
  );
});

test("tall medium details provide an independently scrollable content body", () => {
  const tall = css
    .split("@media (min-width: 768px) and (max-width: 1444px) and (min-height: 961px) {")[1]!
    .split("@media (min-width: 768px) and (max-width: 1444px) and (max-height: 960px)")[0]!;
  expect(tall).toContain("display: flex; flex-direction: column;");
  expect(tall).toContain(
    ".workspace:not(.has-details) { grid-template-rows: minmax(240px, 1fr); }",
  );
  expect(tall).toContain(
    '.workspace[data-view-tab="tasks"]:not(.has-details) { grid-template-rows: auto minmax(240px, 1fr); }',
  );
  expect(tall).toContain(
    "#details-content { flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: var(--sheet-padding-inline); }",
  );
  expect(tall).toContain(
    ".workspace-view > .timeline-view { min-height: 0; display: flex; flex-direction: column; }",
  );
  expect(tall).toContain("height: auto !important; min-height: 0;");
  expect(tall).toContain(
    ".workspace-view > .canvas-view #graph { height: 100% !important; min-height: 0; }",
  );
  expect(tall).toContain(
    ".workspace-view > .canvas-view #atomic-graph { height: 100% !important; min-height: 0; }",
  );
  expect(tall).toContain("overflow-anchor: none;");
});

test("tall medium task boards compress through their ancestor chain", () => {
  expect(css).toContain(".workspace-main { min-width: 0; min-height: 0; }");
  expect(css).toContain(".workspace-view, .workspace-tasks { min-width: 0; min-height: 0; }");
  const tall = css
    .split("@media (min-width: 768px) and (max-width: 1444px) and (min-height: 961px) {")[1]!
    .split("@media (min-width: 768px) and (max-width: 1444px) and (max-height: 960px)")[0]!;
  expect(tall).toContain(
    ".workspace-tasks { display: flex; flex-direction: column; overflow: hidden; margin-right: calc(-1 * var(--sheet-padding-inline)); }",
  );
  expect(tall).toContain(
    ".workspace-tasks .task-list-section { min-height: 0; display: flex; flex: 1 1 auto; flex-direction: column; }",
  );
  expect(tall).toContain(".workspace-tasks .task-list { min-height: 0; flex: 1 1 auto; }");
  expect(tall).toContain(".workspace-tasks .task-layout-board { min-height: 0; }");
});

test("wide timeline views constrain the chart to the viewport height", () => {
  const wide = css.slice(css.lastIndexOf("@media (min-width: 1445px) {"));
  expect(wide).toContain(".main { margin-bottom: 0; padding-bottom: 0; }");
  expect(wide).toContain("height: max(610px, calc(100dvh - 190px));");
  expect(wide).toContain(
    ".workspace-main { min-height: 0; display: flex; flex-direction: column; }",
  );
  expect(wide).toContain(
    ".workspace-view { min-height: 0; display: flex; flex: 1 1 auto; flex-direction: column; }",
  );
  expect(wide).toContain("height: auto !important; min-height: 0;");
});

test("identity actions follow the project name instead of filling the title row", () => {
  expect(css).toContain(".identity-copy { flex: 0 1 auto; min-width: 0; }");
  expect(css).toContain("text-overflow: ellipsis; white-space: nowrap;");
});

test("mobile theme entry shares the title row centerline", () => {
  expect(css).toContain(
    ".topbar .theme-control { position: absolute; top: 12px; right: 16px; width: 44px; height: 44px; min-height: 44px; }",
  );
});

test("compact header icons use optical rather than box-edge spacing", () => {
  expect(css).toContain(
    ".run-profile-control { flex: 0 0 auto; min-width: 0; margin-left: -1px; }",
  );
  expect(css).toContain(
    "display: inline-flex; align-items: center; justify-content: center; width: 30px;",
  );
  expect(css).toContain(
    "width: 16px; height: 16px; flex: 0 0 16px; transform: translateX(-0.5px);",
  );
});

test("mobile header actions use 44px touch targets and 18px icons", () => {
  expect(css).toContain(
    ".topbar .plan-info-trigger { width: 44px; height: 44px; min-height: 44px; flex: 0 0 44px; margin-left: -8px; }",
  );
  expect(css).toContain(
    ".topbar .theme-control .theme-trigger { width: 44px; height: 44px; min-height: 44px;",
  );
  expect(css).toContain(".run-profile-control { flex: 0 0 44px; width: 44px; margin-left: -8px; }");
  expect(css).toContain("width: 18px; height: 18px; flex: 0 0 18px;");
});

test("plan info content does not reserve an empty scrollbar gutter", () => {
  const planInfo = css.match(/\.plan-info-content \{[^}]+\}/)?.[0] ?? "";
  expect(planInfo).not.toContain("scrollbar-gutter: stable");
});

test("timeline vertical scrolling stays on vis-timeline side panel", () => {
  expect(css).toContain(
    ".timeline-view .vis-panel.vis-center { cursor: grab; touch-action: pan-x pan-y !important; overflow: hidden !important; }",
  );
  expect(css).toContain(
    ".timeline-view .vis-panel.vis-left { cursor: grab; touch-action: pan-x pan-y !important; overflow-x: hidden !important; overflow-y: scroll !important; }",
  );
  expect(css).not.toContain(".vis-panel.vis-center::-webkit-scrollbar");
});

test("runtime identity state uses a compact semantic chip", () => {
  expect(css).toContain(".plan-info-identity-state svg { width: 12px; height: 12px; }");
  expect(css).toContain("background: var(--pill-positive-bg);");
  expect(css).toContain("background: var(--pill-warning-bg);");
});

test("plan info section headings establish stronger hierarchy without extra content gap", () => {
  expect(css).toContain(
    ".plan-info-section h3 { margin: 0 0 4px; color: var(--text); font-size: 12px; font-weight: 600; line-height: 1.3; }",
  );
  expect(css).toContain(".plan-info-identity-summary { min-width: 0; padding: 6px 0 9px;");
});
