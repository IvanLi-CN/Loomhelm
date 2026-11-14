import type { Task, View } from "./model";
import { canonicalViewUrl, DEFAULT_VIEW_STATE } from "./view-state";

export function taskUrl(current: string, id: string): string {
  return canonicalViewUrl(current, { ...DEFAULT_VIEW_STATE, selected: { kind: "task", id }, detail: true });
}
export function groupUrl(current: string, id: string): string {
  return canonicalViewUrl(current, { ...DEFAULT_VIEW_STATE, selected: { kind: "group", id }, detail: true });
}
export function milestoneUrl(current: string, id: string, atom?: string | null): string {
  return canonicalViewUrl(current, { ...DEFAULT_VIEW_STATE, selected: { kind: "milestone", id }, atom: atom ?? null, detail: true });
}
export function atomUrl(current: string, parent: { kind: "task" | "group"; id: string }, atom: string): string {
  return canonicalViewUrl(current, { ...DEFAULT_VIEW_STATE, selected: parent, atom, detail: true });
}
export function taskPRs(task: Task, view: View): string[] {
  return [...new Set([task.pr?.url, ...view.follow_prs.filter(pr => pr.origin_task_id === task.id).map(pr => pr.pr.url)]
    .filter((url): url is string => { if (!url) return false; try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; } }))];
}
export function installTaskContextMenu(context: {
  getData: () => View | null;
  beforeOpen?: () => void;
  writeText?: (text: string) => Promise<void>;
}) {
  let menu: HTMLElement | null = null;
  let origin: HTMLElement | null = null;
  let submenu: HTMLElement | null = null;
  const feedback = document.createElement("div");
  feedback.className = "task-copy-feedback"; feedback.role = "status"; feedback.setAttribute("aria-live", "polite"); feedback.hidden = true;
  document.body.append(feedback);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function close(restore = false) { menu?.remove(); menu = null; submenu = null; if (restore && origin?.isConnected) origin.focus({ preventScroll: true }); }
  function position(element: HTMLElement, x: number, y: number) {
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }
  async function copy(label: string, value: string) {
    close(true);
    try { await (context.writeText ?? (text => navigator.clipboard.writeText(text)))(value); feedback.textContent = `${label}：已复制`; }
    catch { feedback.textContent = `${label}：复制失败，请检查剪贴板权限`; }
    feedback.hidden = false; clearTimeout(timer); timer = setTimeout(() => { feedback.hidden = true; }, 3000);
  }
  type Kind = "task" | "group" | "milestone" | "atom";
  function open(event: MouseEvent | KeyboardEvent, kind: Kind, id: string, target: HTMLElement) {
    const view = context.getData();
    const task = kind === "task" ? view?.tasks.find(item => item.id === id) : undefined;
    const group = kind === "group" ? view?.groups.find(item => item.id === id) : undefined;
    const milestone = kind === "milestone" ? view?.nodes.find(item => item.kind === "milestone" && item.id === id) : undefined;
    const atomParent = kind === "atom" ? [...(view?.tasks ?? []).map(item => ({ kind: "task" as const, item })), ...(view?.groups ?? []).map(item => ({ kind: "group" as const, item }))].find(({ item }) => [...(item.atoms ?? []), ...(item.planned_atoms ?? [])].some(atom => atom.id === id)) : undefined;
    const atom = atomParent && [...(atomParent.item.atoms ?? []), ...(atomParent.item.planned_atoms ?? [])].find(item => item.id === id);
    if (!view || (!task && !group && !milestone && !atom)) return;
    event.preventDefault(); event.stopPropagation(); close(); context.beforeOpen?.();
    origin = target.matches("button, a, [tabindex]") ? target : target.querySelector<HTMLElement>("button, a, [tabindex]") ?? target.closest<HTMLElement>("[tabindex]") ?? target;
    menu = document.createElement("div"); menu.className = "task-context-menu"; menu.role = "menu"; menu.setAttribute("aria-label", `${task?.title ?? group?.title ?? milestone?.label ?? atom?.title ?? "对象"}的操作`);
    menu.addEventListener("click", e => e.stopPropagation());
    const add = (parent: HTMLElement, label: string, value: string | null, reason?: string) => {
      const button = document.createElement("button"); button.type = "button"; button.role = "menuitem";
      button.textContent = label; button.tabIndex = -1;
      if (value === null) { button.setAttribute("aria-disabled", "true"); const hint = document.createElement("small"); hint.textContent = reason ?? "不可用"; button.append(hint); }
      else button.addEventListener("click", () => void copy(label, value));
      parent.append(button); return button;
    };
    if (group) {
      add(menu, "复制交付单元 ID", group.id); add(menu, "复制交付单元链接", groupUrl(window.location.href, group.id));
    } else if (milestone) {
      add(menu, "复制里程碑 ID", milestone.id); add(menu, "复制里程碑链接", milestoneUrl(window.location.href, milestone.id));
    } else if (atom && atomParent) {
      add(menu, "复制原子任务 ID", atom.id); add(menu, "复制原子任务链接", atomUrl(window.location.href, { kind: atomParent.kind, id: atomParent.item.id }, atom.id));
    } else {
      add(menu, "复制任务名", task!.title); add(menu, "复制任务 ID", task!.id); add(menu, "复制任务 URL", taskUrl(window.location.href, task!.id));
    }
    if (task) {
      add(menu, "复制对话链接", task.thread_id ? `codex://threads/${task.thread_id}` : null, "尚未绑定对话");
      const prs = taskPRs(task, view);
      if (prs.length <= 1) add(menu, "复制 PR 链接", prs[0] ?? null, "尚未关联 PR");
      else {
      const trigger = add(menu, "复制 PR 链接 ›", null); trigger.removeAttribute("aria-disabled"); trigger.querySelector("small")?.remove();
      trigger.setAttribute("aria-haspopup", "menu"); trigger.setAttribute("aria-expanded", "false");
      const expand = () => {
        if (submenu) { submenu.querySelector<HTMLElement>("button")?.focus(); return; }
        submenu = document.createElement("div"); submenu.className = "task-context-submenu"; submenu.role = "menu"; submenu.setAttribute("aria-label", "选择 PR");
        for (const url of prs) add(submenu, url, url);
        menu!.append(submenu); trigger.setAttribute("aria-expanded", "true");
        const rect = trigger.getBoundingClientRect(); position(submenu, rect.right + 4, rect.top);
        submenu.querySelector<HTMLElement>("button")?.focus();
      };
      trigger.addEventListener("click", expand);
      trigger.addEventListener("keydown", e => { if (e.key === "ArrowRight") { e.preventDefault(); expand(); } });
      }
    }
    menu.addEventListener("keydown", event => {
      const current = (event.target as HTMLElement).closest<HTMLElement>("button"), parent = current?.parentElement;
      const items = parent ? [...parent.children].filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement) : [];
      const index = items.indexOf(current as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus();
      } else if (event.key === "ArrowLeft" && submenu?.contains(current)) {
        event.preventDefault(); submenu.remove(); submenu = null; const trigger = menu!.querySelector<HTMLElement>("[aria-haspopup]"); trigger?.setAttribute("aria-expanded", "false"); trigger?.focus();
      } else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(true); }
      event.stopPropagation();
    });
    document.body.append(menu);
    const rect = target.getBoundingClientRect();
    position(menu, "clientX" in event ? event.clientX : rect.left, "clientY" in event ? event.clientY : rect.bottom);
    menu.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }
  const handleContext = (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-context-kind][data-context-id], [data-context-task]");
    if (target) { const kind = (target.dataset.contextKind ?? "task") as Kind, id = target.dataset.contextId ?? target.dataset.contextTask; if (id) open(event, kind, id, target); }
  };
  const handleKeyboard = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-context-kind][data-context-id], [data-context-task]");
    if (target) { const kind = (target.dataset.contextKind ?? "task") as Kind, id = target.dataset.contextId ?? target.dataset.contextTask; if (id) open(event, kind, id, target); }
  };
  const handleTrigger = (event: MouseEvent) => { const target = (event.target as HTMLElement).closest<HTMLElement>("[data-context-trigger]"); if (!target) return; const kind = target.dataset.contextKind as Kind | undefined, id = target.dataset.contextId; if (kind && id) open(event, kind, id, target); };
  const outside = (event: Event) => { if (menu && !menu.contains(event.target as Node)) close(); };
  document.addEventListener("contextmenu", handleContext, true); document.addEventListener("keydown", handleKeyboard); document.addEventListener("click", handleTrigger);
  document.addEventListener("pointerdown", outside, true); window.addEventListener("resize", closeOnMove); window.addEventListener("scroll", closeOnMove, true);
  function closeOnMove() { close(); }
  return { open: (event: MouseEvent | KeyboardEvent, id: string, target: HTMLElement) => open(event, "task", id, target), openForTarget: (kind: Kind, id: string, target: HTMLElement) => open(new MouseEvent("contextmenu", { clientX: target.getBoundingClientRect().left, clientY: target.getBoundingClientRect().bottom }), kind, id, target), close, destroy() { close(); feedback.remove(); clearTimeout(timer); document.removeEventListener("contextmenu", handleContext, true); document.removeEventListener("keydown", handleKeyboard); document.removeEventListener("click", handleTrigger); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", closeOnMove); window.removeEventListener("scroll", closeOnMove, true); } };
}
