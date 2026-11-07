import type { PRSnapshot } from "../scripts/pr-details";

const cache = new Map<string, { snapshot: PRSnapshot; at: number }>();
const flights = new Map<string, Promise<PRSnapshot>>();
const listeners = new Map<HTMLElement, { url: string; label: string }>();
function svg(paths: string[]): SVGElement {
  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) root.setAttribute(key, value);
  for (const d of paths) { const path = document.createElementNS(root.namespaceURI, "path"); path.setAttribute("d", d); root.append(path); }
  return root;
}
export function publishPRStatus(url: string, snapshot: PRSnapshot): void {
  const previous = cache.get(url)?.snapshot;
  const previousTime = Date.parse(previous?.observed_at ?? "");
  const nextTime = Date.parse(snapshot.observed_at ?? "");
  if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime < previousTime) return;
  cache.set(url, { snapshot, at: Date.now() });
  for (const [trigger, entry] of listeners) {
    if (!trigger.isConnected) { listeners.delete(trigger); continue; }
    if (entry.url === url) paint(trigger, entry.label, snapshot);
  }
}
function paint(trigger: HTMLElement, label: string, snapshot: PRSnapshot): void {
  const data = snapshot.data;
  const merge = data?.state === "MERGED" ? "已合并" : data?.state === "CLOSED" ? "已关闭" : data?.state === "OPEN" ? "待合并" : "合并状态未知";
  const ci = data?.ci ?? "未知";
  trigger.dataset.prState = data?.state ?? "UNKNOWN";
  trigger.dataset.ciState = ci;
  const description = `${label} · ${merge} · CI ${ci}${snapshot.stale ? " · 数据已过期" : ""}${snapshot.error ? " · 查询失败" : ""}`;
  trigger.setAttribute("aria-label", description);
  trigger.setAttribute("aria-description", description);
  const main = svg(data?.state === "MERGED" ? ["M6 3v12a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M18 9a6 6 0 0 1-6 6H6"] : ["M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M6 9v6a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M15 3h3v12a3 3 0 1 0 0 6 3 3 0 0 0 0-6"]);
  const mark = document.createElement("span"); mark.className = "pr-ci-mark"; mark.setAttribute("aria-hidden", "true");
  mark.append(svg(ci === "成功" ? ["m5 12 4 4L19 6"] : ci === "失败" ? ["m6 6 12 12", "M18 6 6 18"] : ci === "运行中" ? ["M20 12a8 8 0 1 0-8 8"] : ["M12 5v8", "M12 17h.01"]));
  trigger.replaceChildren(main);
  if (["成功", "失败", "运行中"].includes(ci)) trigger.append(mark);
}
export function bindPRStatus(trigger: HTMLElement, kind: "task" | "group", id: string, url: string): void {
  for (const node of listeners.keys()) if (!node.isConnected) listeners.delete(node);
  const label = trigger.getAttribute("aria-label") ?? "打开 PR";
  listeners.set(trigger, { url, label });
  const previous = cache.get(url);
  if (previous) paint(trigger, label, previous.snapshot);
  if (previous && Date.now() - previous.at < 30_000) return;
  let flight = flights.get(url);
  if (!flight) {
    flight = fetch(`api/resource-details?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("PR status unavailable");
      return await response.json() as PRSnapshot;
    });
    flights.set(url, flight);
    // A popover may publish while this independent card request is in flight.
    void flight.then(snapshot => {
      if (cache.get(url) === previous) publishPRStatus(url, snapshot);
    }, () => {
      if (previous && cache.get(url) === previous) publishPRStatus(url, { ...previous.snapshot, stale: true });
    }).finally(() => flights.delete(url));
  }
}
