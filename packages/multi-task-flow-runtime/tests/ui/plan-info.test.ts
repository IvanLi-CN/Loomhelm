import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { View } from "../../web/model";
import {
  type RuntimeMetadata,
  readEmbeddedViewerProvenance,
  runtimeWithEmbeddedViewer,
} from "../../web/runtime-metadata";
import { renderPlanInfoContent } from "../../web/status-row";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Node: dom.Node,
});
beforeEach(() => document.body.replaceChildren());

const view = {
  orchestration: { repository: { owner: "Ivan", name: "Loomhelm" }, revision: 7 },
  groups: [],
  tasks: [],
  selected_plan_id: "plan-1",
  execution_phase: "implementation",
  plan_state: undefined,
} as unknown as Pick<
  View,
  "orchestration" | "groups" | "tasks" | "selected_plan_id" | "execution_phase" | "plan_state"
>;

const runtime: RuntimeMetadata = {
  static_viewer: {
    schema_version: 1,
    source: "package",
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.23",
    compatibility_line: "compat-v1",
    skill_version: "2.7.10",
    viewer_contract: 5,
    build_id: "b".repeat(64),
    source_sha: "a".repeat(40),
  },
  daemon: {
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.23",
    compatibility_line: "compat-v1",
    skill_version: "2.7.11",
    viewer_contract: 5,
    service_contract: "1",
    build_id: "c".repeat(64),
    source_sha: "c".repeat(40),
  },
  warning: null,
};

test("renders runtime identity before plan details and exposes copy controls", () => {
  const container = document.createElement("div");
  document.body.append(container);
  renderPlanInfoContent(container, view, runtime);
  expect(container.querySelector("h3")?.textContent).toBe("运行时身份");
  expect(container.textContent).toContain("@loomhelm/multi-task-flow@0.2.23");
  expect(container.textContent).toContain("b".repeat(64));
  expect(container.querySelectorAll(".plan-info-copy").length).toBeGreaterThan(5);
  expect(container.textContent).toContain(
    "静态 Viewer 与 Daemon 身份不一致，当前网页来源需要核对。",
  );
  expect(container.textContent).toContain("Daemon Skill");
  expect(container.textContent).toContain("2.7.11");
  expect(container.textContent).toContain("Daemon source SHA");
  expect(container.querySelector<HTMLDetailsElement>(".plan-info-disclosure-mobile")?.open).toBe(
    false,
  );
  expect(
    container
      .querySelector<HTMLButtonElement>(".plan-info-identity-trigger")
      ?.getAttribute("aria-label"),
  ).toBe("查看版本详情");
  expect(container.querySelector(".plan-info-identity-state")?.textContent).toBe("需核对");
  expect(container.querySelector(".plan-info-identity-state i")?.getAttribute("data-lucide")).toBe(
    "circle-alert",
  );
  const trigger = container.querySelector<HTMLButtonElement>(".plan-info-identity-trigger")!;
  trigger.click();
  expect(document.querySelector(".plan-info-identity-tooltip")?.textContent).toContain("版本详情");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  renderPlanInfoContent(container, view, runtime);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("keeps deterministic fallbacks when runtime identity is unavailable", () => {
  const container = document.createElement("div");
  renderPlanInfoContent(container, view, null);
  expect(container.textContent).toContain("未知（静态资源未声明 package 身份）");
  expect(container.textContent).toContain("未知（daemon 未提供 package 身份）");
  expect(container.textContent).toContain("未知（未声明兼容线）");
  expect(container.querySelector<HTMLDetailsElement>(".plan-info-disclosure-mobile")?.open).toBe(
    false,
  );
});

test("keeps aligned runtime identity compact until details are requested", () => {
  const container = document.createElement("div");
  const aligned: RuntimeMetadata = {
    ...runtime,
    daemon: {
      ...runtime.daemon,
      skill_version: runtime.static_viewer.skill_version,
      build_id: runtime.static_viewer.build_id,
      source_sha: runtime.static_viewer.source_sha,
    },
  };
  renderPlanInfoContent(container, view, aligned);
  expect(container.querySelector(".plan-info-identity-summary")?.getAttribute("data-status")).toBe(
    "aligned",
  );
  expect(container.querySelector(".plan-info-identity-package")?.textContent).toBe(
    "@loomhelm/multi-task-flow@0.2.23",
  );
  expect(container.querySelector(".plan-info-identity-meta")?.textContent).toContain(
    "兼容线 compat-v1",
  );
  expect(container.querySelector<HTMLDetailsElement>(".plan-info-disclosure-mobile")?.open).toBe(
    false,
  );
  expect(container.querySelector(".plan-info-identity-trigger")).not.toBeNull();
  expect(container.querySelector(".plan-info-identity-state")?.textContent).toBe("一致");
  expect(container.querySelector(".plan-info-identity-state i")?.getAttribute("data-lucide")).toBe(
    "circle-check",
  );
  expect(container.querySelector(".plan-info-identity-tooltip")).toBeNull();
});

test("does not call incomplete runtime identity aligned", () => {
  const container = document.createElement("div");
  const aligned: RuntimeMetadata = {
    ...runtime,
    daemon: {
      ...runtime.daemon,
      skill_version: runtime.static_viewer.skill_version,
      build_id: runtime.static_viewer.build_id,
      source_sha: runtime.static_viewer.source_sha,
    },
  };
  const incomplete: RuntimeMetadata = { ...aligned, daemon: { ...aligned.daemon, build_id: null } };
  renderPlanInfoContent(container, view, incomplete);
  expect(container.querySelector(".plan-info-identity-summary")?.getAttribute("data-status")).toBe(
    "unknown",
  );
  expect(container.querySelector(".plan-info-identity-state")?.textContent).toBe("未知");
  expect(container.querySelector(".plan-info-identity-state i")?.getAttribute("data-lucide")).toBe(
    "circle-help",
  );
});

test("does not call an unknown static source aligned", () => {
  const container = document.createElement("div");
  const aligned: RuntimeMetadata = {
    ...runtime,
    daemon: {
      ...runtime.daemon,
      skill_version: runtime.static_viewer.skill_version,
      build_id: runtime.static_viewer.build_id,
      source_sha: runtime.static_viewer.source_sha,
    },
  };
  const unknownSource: RuntimeMetadata = {
    ...aligned,
    static_viewer: { ...runtime.static_viewer, source: "unknown" },
  };
  renderPlanInfoContent(container, view, unknownSource);
  expect(container.querySelector(".plan-info-identity-summary")?.getAttribute("data-status")).toBe(
    "unknown",
  );
  expect(container.querySelector(".plan-info-identity-state")?.textContent).toBe("未知");
});

test("normalizes embedded provenance and lets server runtime metadata win", () => {
  const marker = {
    schema_version: 1,
    source: "package",
    package_name: "@loomhelm/multi-task-flow",
    package_version: "0.2.23",
    compatibility_line: "compat-v1",
    skill_version: "2.7.10",
    viewer_contract: 5,
    build_id: "b".repeat(64),
    source_sha: "a".repeat(40),
  };
  document.body.innerHTML = `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify({ ...marker, build_id: "__LOOMHELM_ARTIFACT_BUILD_ID__" })}</script>`;
  expect(readEmbeddedViewerProvenance(document)).toMatchObject({
    source: "unknown",
    package_name: null,
    build_id: null,
  });
  document.body.innerHTML = `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify(marker)}</script><script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify(marker)}</script>`;
  expect(readEmbeddedViewerProvenance(document).source).toBe("unknown");
  const customRuntime = {
    ...runtime,
    static_viewer: {
      schema_version: 1 as const,
      source: "custom-view" as const,
      package_name: null,
      package_version: null,
      compatibility_line: null,
      skill_version: null,
      viewer_contract: null,
      build_id: null,
      source_sha: null,
    },
  };
  document.body.innerHTML = `<script id="loomhelm-viewer-provenance" type="application/json">${JSON.stringify(marker)}</script>`;
  expect(runtimeWithEmbeddedViewer(customRuntime, document).static_viewer.source).toBe(
    "custom-view",
  );
  expect(
    runtimeWithEmbeddedViewer(null, document, { trustEmbeddedViewer: false }).static_viewer.source,
  ).toBe("unknown");
});
