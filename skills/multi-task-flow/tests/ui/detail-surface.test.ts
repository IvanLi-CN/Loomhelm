import { beforeEach, describe, expect, test } from "bun:test";
import { getByText } from "@testing-library/dom";
import { applyDetailSurface, type DetailSurfaceElements } from "../../web/detail-surface";
import { firstVisibleElement, focusAfterRerender } from "../../web/focus";
import { canShowHoverPreview, detailsPanelFits, isDetailInteraction, resolveDetailSurface, selectedObjectFocusSelector, supportsHoverInput } from "../../web/interaction-policy";

let elements: DetailSurfaceElements;

beforeEach(() => {
  document.body.innerHTML = `
    <header id="app-header"><button>主题</button></header>
    <section class="workspace">
      <main id="background-content"></main>
      <div class="details-slot" hidden><aside id="details" aria-hidden="true"><div id="details-content">已选详情</div></aside></div>
      <div id="details-backdrop" hidden></div>
    </section>
    <div id="hover-preview" hidden></div>
    <button id="close-details">关闭</button>
  `;
  elements = {
    workspace: document.querySelector(".workspace")!,
    background: [document.querySelector("#app-header")!, document.querySelector("#background-content")!],
    details: document.querySelector("#details")!,
    detailsBackdrop: document.querySelector("#details-backdrop")!,
    hoverPreview: document.querySelector("#hover-preview")!,
    closeDetails: document.querySelector("#close-details")!,
  };
});

describe("dashboard detail surface DOM", () => {
  test("does not reserve a detail column before an object is selected", () => {
    const surface = resolveDetailSurface({ selected: false, detailOpen: false, hoverCapable: true, detailPanelViewport: true });
    applyDetailSurface(elements, surface, true);

    expect(surface).toBe("none");
    expect(elements.details.hidden).toBe(true);
    expect(elements.details.closest<HTMLElement>(".details-slot")?.hidden).toBe(true);
    expect(elements.workspace.classList.contains("has-details")).toBe(false);
    expect(canShowHoverPreview({ selected: false, detailOpen: false, hoverCapable: true, detailPanelViewport: true })).toBe(true);
  });

  test("opens the wide inspector only for an explicitly selected object", () => {
    const surface = resolveDetailSurface({ selected: true, detailOpen: true, hoverCapable: true, detailPanelViewport: true });
    applyDetailSurface(elements, surface, true);

    expect(surface).toBe("desktop-inspector");
    expect(elements.details.hidden).toBe(false);
    expect(elements.details.closest<HTMLElement>(".details-slot")?.hidden).toBe(false);
    expect(elements.workspace.classList.contains("has-details")).toBe(true);
  });

  test("uses an overlay inspector when the panel would shrink the canvas", () => {
    const surface = resolveDetailSurface({ selected: true, detailOpen: true, hoverCapable: true, drawerViewport: false });
    applyDetailSurface(elements, surface, false);

    expect(surface).toBe("overlay-inspector");
    expect(elements.details.hidden).toBe(false);
    expect(elements.details.classList.contains("open")).toBe(true);
    expect(elements.detailsBackdrop.hidden).toBe(false);
    expect(elements.workspace.classList.contains("has-overlay-selection")).toBe(true);
  });

  test("uses a fixed inspector on the intermediate viewport only after selection", () => {
    expect(resolveDetailSurface({ selected: false, detailOpen: false, hoverCapable: true, detailPanelViewport: true })).toBe("none");

    const surface = resolveDetailSurface({ selected: true, detailOpen: true, hoverCapable: true, detailPanelViewport: true });
    applyDetailSurface(elements, surface, true);

    expect(surface).toBe("desktop-inspector");
    expect(elements.details.hidden).toBe(false);
    expect(elements.workspace.classList.contains("has-details")).toBe(true);
    expect(elements.detailsBackdrop.hidden).toBe(true);
  });

  test("does not allow a hover preview beside an open desktop inspector", () => {
    expect(canShowHoverPreview({ selected: true, detailOpen: true, hoverCapable: true, detailPanelViewport: true })).toBe(false);
    expect(canShowHoverPreview({ selected: false, detailOpen: false, hoverCapable: true, detailPanelViewport: true })).toBe(true);
    expect(canShowHoverPreview({ selected: true, detailOpen: true, hoverCapable: true, detailPanelViewport: false })).toBe(false);
  });

  test("uses the canvas width for the detail panel threshold", () => {
    expect(detailsPanelFits(1356)).toBe(true);
    expect(detailsPanelFits(1355)).toBe(false);
  });

  test("keeps a touch-selected object in the narrow drawer surface", () => {
    expect(resolveDetailSurface({ selected: true, detailOpen: true, hoverCapable: false, drawerViewport: true })).toBe("drawer");
  });

  test("uses the active pointer type on a hybrid touch device", () => {
    expect(supportsHoverInput({ anyHover: true, anyFinePointer: true })).toBe(true);
    expect(supportsHoverInput({ anyHover: true, anyFinePointer: true, pointerType: "mouse" })).toBe(true);
    expect(supportsHoverInput({ anyHover: true, anyFinePointer: true, pointerType: "touch" })).toBe(false);
    expect(supportsHoverInput({ anyHover: true, anyFinePointer: true, pointerType: "pen" })).toBe(false);
    expect(supportsHoverInput({ anyHover: false, anyFinePointer: true })).toBe(false);
    expect(supportsHoverInput({ anyHover: true, anyFinePointer: false })).toBe(false);
  });

  test("switches from a touch drawer to one mouse hover surface", () => {
    applyDetailSurface(elements, "drawer", false);
    elements.hoverPreview.hidden = false;
    elements.hoverPreview.classList.add("is-visible");

    applyDetailSurface(elements, "hover-preview", false);

    expect(elements.details.hidden).toBe(true);
    expect(elements.details.classList.contains("open")).toBe(false);
    expect(elements.detailsBackdrop.hidden).toBe(true);
    expect(elements.hoverPreview.hidden).toBe(false);
    expect(elements.hoverPreview.classList.contains("is-visible")).toBe(true);
  });

  test("keeps keyboard-selected details in one surface", () => {
    expect(resolveDetailSurface({ selected: true, detailOpen: true, hoverCapable: true, keyboardSelection: true, drawerViewport: true })).toBe("drawer");
    expect(canShowHoverPreview({ selected: true, detailOpen: true, hoverCapable: true, keyboardSelection: true })).toBe(false);
  });

  test("keeps accessible graph selection inside the detail interaction boundary", () => {
    const graphA11y = document.createElement("div");
    graphA11y.id = "graph-a11y";
    const button = document.createElement("button");
    graphA11y.append(button);
    document.body.append(graphA11y);

    expect(isDetailInteraction(button)).toBe(true);
    expect(isDetailInteraction(document.createElement("div"))).toBe(false);
  });

  test("keeps only the selected object's desktop inspector visible", () => {
    elements.hoverPreview.hidden = false;
    elements.hoverPreview.classList.add("is-visible");
    applyDetailSurface(elements, "desktop-inspector", true);

    expect(elements.details.hidden).toBe(false);
    expect(elements.workspace.classList.contains("has-details")).toBe(true);
    expect(elements.hoverPreview.hidden).toBe(true);
    expect(elements.hoverPreview.classList.contains("is-visible")).toBe(false);
    expect(getByText(elements.details, "已选详情")).toBeTruthy();
  });

  test("moves focus into the desktop inspector when details open", async () => {
    applyDetailSurface(elements, "desktop-inspector", true, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(elements.details);
  });

  test("opens a touch drawer with a backdrop and no hover surface", async () => {
    elements.hoverPreview.hidden = false;
    applyDetailSurface(elements, "drawer", false, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(elements.details.hidden).toBe(false);
    expect(elements.details.classList.contains("open")).toBe(true);
    expect(elements.details.getAttribute("aria-hidden")).toBe("false");
    expect(elements.details.getAttribute("aria-modal")).toBe("false");
    expect(elements.details.getAttribute("role")).toBe("dialog");
    expect(elements.detailsBackdrop.hidden).toBe(false);
    expect(elements.hoverPreview.hidden).toBe(true);
    expect(elements.workspace.classList.contains("has-drawer-selection")).toBe(true);
    expect(document.querySelector("#background-content")?.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("#background-content")?.getAttribute("aria-hidden")).toBeNull();
    expect(document.querySelector("#app-header")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(elements.closeDetails!);
  });

  test("closes every transient surface without changing selected detail content", () => {
    elements.hoverPreview.hidden = false;
    elements.hoverPreview.classList.add("is-visible");
    applyDetailSurface(elements, "none", false);

    expect(elements.details.classList.contains("open")).toBe(false);
    expect(elements.detailsBackdrop.hidden).toBe(true);
    expect(elements.hoverPreview.hidden).toBe(true);
    expect(getByText(elements.details, "已选详情")).toBeTruthy();
  });

  test("restores focus to the selected object's action button after a list rerender", () => {
    document.body.insertAdjacentHTML("beforeend", `
      <article data-task-id="deploy"><button class="task-card-select">部署并验证</button></article>
      <article data-group-id="core"><button class="task-card-select">第一组</button></article>
    `);

    const taskButton = document.querySelector<HTMLElement>(selectedObjectFocusSelector({ kind: "task", id: "deploy" })!);
    const groupButton = document.querySelector<HTMLElement>(selectedObjectFocusSelector({ kind: "group", id: "core" })!);

    expect(taskButton?.textContent).toBe("部署并验证");
    expect(groupButton?.textContent).toBe("第一组");
    document.body.insertAdjacentHTML("beforeend", `<article data-group-id="board"><button class="task-column-select">看板组</button></article>`);
    expect(document.querySelector<HTMLElement>(selectedObjectFocusSelector({ kind: "group", id: "board" })!)?.textContent).toBe("看板组");
    expect(selectedObjectFocusSelector(null)).toBeNull();
  });

  test("falls back to a stable control when a rerender removes the prior focus target", () => {
    const selected = document.createElement("button");
    const fallback = document.createElement("input");
    document.body.append(selected, fallback);
    selected.focus();
    selected.remove();

    focusAfterRerender(selected, fallback);

    expect(document.activeElement).toBe(fallback);
  });

  test("does not restore focus to the document body", () => {
    const fallback = document.createElement("button");
    document.body.append(fallback);
    focusAfterRerender(document.body, fallback);
    expect(document.activeElement).toBe(fallback);
  });

  test("does not focus a control inside a hidden ancestor", () => {
    const hiddenSection = document.createElement("section");
    hiddenSection.hidden = true;
    const hiddenButton = document.createElement("button");
    const fallback = document.createElement("button");
    hiddenSection.append(hiddenButton);
    document.body.append(hiddenSection, fallback);

    focusAfterRerender(hiddenButton, fallback);

    expect(document.activeElement).toBe(fallback);
  });

  test("skips hidden focus targets when selecting a visible list fallback", () => {
    document.body.innerHTML += `
      <section hidden><button class="task-card-select" id="hidden-task">隐藏任务</button></section>
      <section><button class="task-card-select" id="visible-task">可见任务</button></section>
    `;

    expect(firstVisibleElement(document, ".task-card-select")?.id).toBe("visible-task");
  });

  test("returns menu focus to the trigger after the option is dismissed", () => {
    const trigger = document.createElement("button");
    const option = document.createElement("button");
    document.body.append(trigger, option);
    option.focus();

    focusAfterRerender(trigger, trigger);

    expect(document.activeElement).toBe(trigger);
  });
});
