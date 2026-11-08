export function viewerPage(
  title: string,
  body: string,
  script?: string,
): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark;font:15px system-ui}body{max-width:1120px;margin:48px auto;padding:0 24px}header{border-bottom:1px solid #8886;padding-bottom:24px}h1{font-size:28px;font-weight:600}p{line-height:1.7}a{color:inherit}ul{list-style:none;padding:0}li{border-bottom:1px solid #8884;padding:20px 0;display:flex;gap:16px;flex-wrap:wrap}code,small{font-family:monospace}small{opacity:.7}#status{min-height:24px}button{padding:8px 16px}</style><header><small>MULTI TASK FLOW / SHARED VIEWER</small><h1>${title}</h1></header>${body}${script ? `<script src="${script}" defer></script>` : ""}</html>`;
}

export const loginPage = viewerPage(
  "连接本地展示服务",
  '<p id="status" role="status">正在验证一次性登录入口。</p>',
  "/login.js",
);
export function pendingTaskTarget(value: string | null, origin: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || !/^\/runs\/[A-Za-z0-9_-]+\/$/.test(url.pathname)) return null;
    const selected = url.searchParams.get("selected");
    if (!selected || !/^task:[A-Za-z0-9_-]{1,128}$/.test(selected)) return null;
    return url.pathname + "?" + new URLSearchParams({ selected, detail: "1" });
  } catch { return null; }
}
export const resumeTaskScript = `const pendingTaskTarget=${pendingTaskTarget.toString()};try{const target=pendingTaskTarget(location.href,location.origin);if(target)sessionStorage.setItem("multi-task-flow.pending-task",target)}catch{}`;
export const loginScript = `const ticket=location.hash.slice(1);history.replaceState(null,"","/login");fetch("/api/v1/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})}).then(async r=>{if(!r.ok)throw Error();const v=await r.json();let target=null;try{const pending=sessionStorage.getItem("multi-task-flow.pending-task");target=(${pendingTaskTarget.toString()})(pending,location.origin);sessionStorage.removeItem("multi-task-flow.pending-task")}catch{}location.replace(target||v.target)}).catch(()=>{document.getElementById("status").textContent="入口已过期或已使用。请通过 service login 重新获取。"});`;
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
