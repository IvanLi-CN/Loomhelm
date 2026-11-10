export function viewerPage(
  title: string,
  body: string,
  script?: string,
): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark;font:15px system-ui}body{max-width:1120px;margin:48px auto;padding:0 24px}header{border-bottom:1px solid #8886;padding-bottom:24px}h1{font-size:28px;font-weight:600}p{line-height:1.7}a{color:inherit}ul{list-style:none;padding:0}li{border-bottom:1px solid #8884;padding:20px 0;display:flex;gap:16px;flex-wrap:wrap}code,small{font-family:monospace}small{opacity:.7}#status{min-height:24px}button{padding:8px 16px}</style><header><small>MULTI TASK FLOW / SHARED VIEWER</small><h1>${title}</h1></header>${body}${script ? `<script src="${script}" defer></script>` : ""}</html>`;
}

const runPathPattern = /^\/runs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/$/;
const viewIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const viewParamValidators: Record<string, (value: string) => boolean> = {
  tab: (value) => /^(graph|planned|actual)$/.test(value),
  layout: (value) => /^(board|grid)$/.test(value),
  q: (value) => value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value),
  group: (value) => viewIdPattern.test(value),
  state: (value) => viewIdPattern.test(value),
  kind: (value) => viewIdPattern.test(value),
  plan: (value) => viewIdPattern.test(value),
  selected: (value) => /^(task|group|milestone):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value),
  detail: (value) => value === "1" || value === "true",
  zoom: (value) => {
    const zoom = Number(value);
    return Number.isFinite(zoom) && zoom >= 0.2 && zoom <= 2.5;
  },
  plannedStart: (value) => value.length <= 64 && !Number.isNaN(Date.parse(value)),
  plannedEnd: (value) => value.length <= 64 && !Number.isNaN(Date.parse(value)),
  actualStart: (value) => value.length <= 64 && !Number.isNaN(Date.parse(value)),
  actualEnd: (value) => value.length <= 64 && !Number.isNaN(Date.parse(value)),
};
const maxTimelineSpanMs = 10_000 * 365.25 * 24 * 60 * 60 * 1000;

export type ViewerTarget = { target: string; ticket: string | null };
export function parseViewerTarget(
  value: string | URL,
  origin: string,
  options: { allowHome?: boolean; allowTicket?: boolean } = {},
): ViewerTarget | null {
  const allowHome = options.allowHome ?? true;
  const allowTicket = options.allowTicket ?? false;
  try {
    const rawPath = typeof value === "string" ? value.split(/[?#]/, 1)[0]! : null;
    if (rawPath && (rawPath.includes("\\") || /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(rawPath))) return null;
    const url = value instanceof URL ? new URL(value.href) : new URL(value, origin);
    if (typeof value === "string" && value.trim() !== value) return null;
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    const home = url.pathname === "/";
    if ((!home || !allowHome) && !runPathPattern.test(url.pathname)) return null;
    const ticketValues = url.searchParams.getAll("ticket");
    if (ticketValues.length > 1 || (ticketValues.length > 0 && !allowTicket)) return null;
    const ticket = ticketValues[0] ?? null;
    if (ticket !== null && (ticket.length > 100 || /[\u0000-\u001f\u007f]/.test(ticket))) return null;
    let selected = false;
    let detail = false;
    for (const [key, parameter] of url.searchParams) {
      if (key === "ticket") continue;
      if (home || /[\u0000-\u001f\u007f]/.test(parameter) || !viewParamValidators[key] || url.searchParams.getAll(key).length !== 1 || !viewParamValidators[key]!(parameter)) return null;
      if (key === "selected") selected = true;
      if (key === "detail") detail = true;
    }
    if (detail && !selected) return null;
    for (const [start, end] of [["plannedStart", "plannedEnd"], ["actualStart", "actualEnd"]] as const) {
      const startValue = url.searchParams.get(start);
      const endValue = url.searchParams.get(end);
      if ((startValue === null) !== (endValue === null)) return null;
      if (startValue && endValue && (Date.parse(startValue) >= Date.parse(endValue) || Date.parse(endValue) - Date.parse(startValue) > maxTimelineSpanMs)) return null;
    }
    url.searchParams.delete("ticket");
    return { target: url.pathname + url.search, ticket };
  } catch {
    return null;
  }
}

export const authFailedPage = viewerPage(
  "登录入口失效",
  '<p id="status" role="status">一次性登录入口已过期或已使用。</p><p>请重新运行 service login 获取新的入口，然后刷新此页面。</p>',
);
export const homePage = viewerPage(
  "编排运行",
  '<p id="status" role="status">正在读取运行。</p><ul id="runs"></ul><button id="more" hidden>加载更多</button><p><small id="build"></small></p>',
  "/home.js",
);
export const homeScript = `let offset=0;const status=document.getElementById("status"),more=document.getElementById("more");async function renew(){try{const r=await fetch("/api/v1/lease",{method:"POST"});if(!r.ok)throw Error();}catch{status.textContent="服务已断开。若已退出，请先调用 service ensure；如登录过期，请重新获取登录入口。"}}async function load(){try{const r=await fetch("/api/v1/runs?offset="+offset);if(!r.ok)throw Error();const v=await r.json();for(const run of v.runs){const li=document.createElement("li"),a=document.createElement("a"),meta=document.createElement("small");a.textContent=run.id;a.href="/runs/"+encodeURIComponent(run.id)+"/";meta.textContent=run.error||("revision "+run.revision+" / "+run.owner_thread_id);li.append(a,meta);document.getElementById("runs").append(li)}offset+=v.runs.length;more.hidden=offset>=v.total;status.textContent=v.total?"共 "+v.total+" 个运行":"暂无编排运行";document.getElementById("build").textContent="build "+v.build_id;}catch{status.textContent="无法读取运行。请确认服务在线并通过 service login 登录。"}}more.onclick=load;load();renew();setInterval(renew,60000);document.addEventListener("visibilitychange",()=>{if(!document.hidden)renew()});`;

export const runClientScript = `
const brand=document.querySelector(".brand-mark");
if(brand){
  const home=document.createElement("a");
  home.className=brand.className;home.href="/";
  home.setAttribute("aria-label","全部编排运行");home.dataset.tooltip="全部编排运行";
  home.append(...brand.childNodes);brand.replaceWith(home);
}
async function renew(){
  try{
    const r=await fetch("/api/v1/lease",{method:"POST"});
    document.dispatchEvent(new CustomEvent("service-session",{detail:{expired:r.status===401}}));
  }catch{/* The dashboard owns connection and snapshot feedback. */}
}
fetch("api/service").then(r=>r.ok?r.json():null).then(v=>{
  if(!v)return;
  const home=document.querySelector(".brand-mark");
  if(home)home.dataset.tooltip="全部编排运行 · build "+v.build_id;
  if(v.warning){
    const anchor=document.getElementById("connection-notice");
    if(anchor){const notice=document.createElement("div");notice.className="notice notice-warning";notice.setAttribute("role","status");notice.textContent=v.warning;anchor.after(notice)}
  }
}).catch(()=>{});
renew();setInterval(renew,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)renew()});
`;
