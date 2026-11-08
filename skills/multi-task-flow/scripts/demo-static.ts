import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSingleDeliveryUnitOutputs } from "../examples/single-delivery-unit/outputs";
import { createSingleDeliveryUnitLedger } from "../examples/single-delivery-unit/ledger";
import { createDemoLedger } from "../examples/orchestration-viewer/ledger";
import type { AgentOutput } from "../web/agent-output";
import type { Task } from "../web/model";
import { buildView } from "./view";
import { archiveFixtureScript } from "./demo-archive";

const output = join(import.meta.dir, "..", "dist");
const archiveDemo = process.argv.includes("--archive-fixture");
const outputDemo = archiveDemo || process.argv.includes("--agent-output");
const singleUnit = process.argv.includes("--single-delivery-unit");
const ledger = singleUnit ? createSingleDeliveryUnitLedger() : outputDemo
  ? createDemoLedger(Date.parse("2026-11-05T08:00:00Z"))
  : createDemoLedger();
// The static shim has no native connection; only synthetic text is rendered.
const demoTasks = ledger.tasks.map((task) => ({
  ...task,
  thread_id: task.id === "verify" ? null : `demo-${task.id}`,
}));
const demoOutputs = Object.fromEntries(
  demoTasks.map((task, index) => [
    task.id,
    {
      state: !task.thread_id
        ? "no_conversation"
        : index === 2
          ? "unavailable"
          : index === 3
            ? "empty"
            : "available",
      text:
        !task.thread_id || index === 3
          ? null
          : `已完成接口与数据投影核对，正在验证实时更新。\n这是任务 ${task.title} 的最新 Agent 进展。\n卡片和悬浮卡片按展示行数截断，详情保留完整换行。`.repeat(
              3,
            ),
      thread_title: `演示对话 · ${task.title}`,
      thread_id: task.thread_id,
      turn_id: "demo-turn",
      message_id: "demo-message",
      phase: "commentary",
      message_status: "in_progress",
      observed_at: "2026-11-05T08:00:00Z",
      stale: index === 2,
    },
  ]),
);
const view = buildView(
  ledger,
  undefined,
  singleUnit ? createSingleDeliveryUnitOutputs(ledger) : outputDemo ? (demoOutputs as Record<string, AgentOutput>) : {},
);
if (outputDemo && !singleUnit)
  for (const task of view.tasks as Task[])
    task.thread_id = demoOutputs[task.id]!.thread_id;
if (archiveDemo) {
  // Controlled fixture: no live Codex connection or ledger writes.
  view.profile_read_only = false;
  view.follow_prs = view.follow_prs.filter(pr => !["model", "scheduler", "server"].includes(pr.origin_task_id));
  for (const task of view.tasks as Task[]) {
    task.latest_agent_output!.text = `任务 ${task.title} 的受控运行时观察。`;
    if (task.id === "deploy" || task.id === "dashboard-ui") {
      task.latest_agent_output!.agent_state = task.id === "deploy" ? "active" : "idle";
      task.latest_agent_output!.stale = false;
      if (task.id === "dashboard-ui") { task.state = "agent_idle"; task.agent_resume_state = "running"; }
    }
    if (["model", "scheduler", "server"].includes(task.id)) {
      task.conversation_archive = { eligible: true, reason: null };
      task.latest_agent_output!.agent_state = "idle";
      task.latest_agent_output!.stale = false;
      task.state = "closed";
      task.conversation_resource = null;
    }
    if (task.id === "server") task.conversation_resource = {
      id: "fixture-server", kind: "conversation", target: task.thread_id!, status: "closed", evidence_ref: "fixture:closed",
    };
    if (task.id === "model" || task.id === "ledger") task.conversation_resource = {
      id: `fixture-${task.id}`, kind: "conversation", target: task.thread_id!,
      status: task.id === "model" ? "archive_failed" : "archive_unknown",
      error: task.id === "model" ? "归档请求被拒绝，可重新尝试" : "归档请求回执丢失，需要对账确认",
      evidence_ref: `fixture:archive:${task.id}`, operation_id: `fixture-${task.id}`,
      last_attempt_at: "2026-11-05T08:00:00Z",
    };
  }
}
if (outputDemo && !singleUnit) for (const group of view.groups) {
  group.agent_thread_id = `demo-group-${group.id}`;
  group.latest_agent_output = { ...demoOutputs[demoTasks[0]!.id]!, thread_id: group.agent_thread_id, thread_title: `交付单元对话 · ${group.title}` } as AgentOutput;
}
const groups = view.groups as Array<Record<string, unknown>>;
// Synthetic presentation variant; never changes or initializes a real run.
if (process.argv.includes("--bootstrap") && groups[0]) {
  groups[0].delivery_unit_kind = "bootstrap";
  groups[0].owner_kind = "main";
  groups[0].agent_thread_id = null;
}

const response = JSON.stringify({
  revision: ledger.revision,
  output_epoch: "static-demo",
  output_revision: 1,
  watching: outputDemo || singleUnit,
  active_plan_id: ledger.active_plan_id,
  view,
}).replaceAll("<", "\\u003c");
const preferences = JSON.stringify({ schema_version: 1, theme: "system" });
const documents = join(output, "demo-documents");
mkdirSync(documents, { recursive: true });
for (const item of [...ledger.groups, ...ledger.tasks]) {
  if (!item.requirements_path) continue;
  const name = item.requirements_path.slice("requirements/".length);
  const sourcePath = join(
    import.meta.dir,
    "..",
    "examples",
    "orchestration-viewer",
    "requirements",
    name,
  );
  const markdown = readFileSync(sourcePath, "utf8");
  const escaped = markdown
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const title = item.title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  copyFileSync(sourcePath, join(documents, name));
  writeFileSync(
    join(documents, `${name.slice(0, -3)}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px/1.7 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#253a33}pre{white-space:pre-wrap;font:inherit}a{color:#286f89}</style><a href="${name}">Markdown 源文件</a><pre>${escaped}</pre></html>`,
  );
}
const profileDemo = JSON.stringify({
  capabilities: [
    {
      model: "gpt-6.1-sol",
      thinking: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      model: "gpt-6-luna",
      thinking: ["low", "medium", "high", "xhigh", "max"],
    },
  ],
  read_only: true,
});
const archiveShim = archiveDemo ? archiveFixtureScript(response, preferences, profileDemo) : "";
const prDemo = JSON.stringify({ data: { number: 42, title: "演示 PR：卡片悬浮信息", url: "https://github.com/example/repo/pull/42", state: "OPEN", mergedAt: null, mergeable: "MERGEABLE", ci: "运行中", checks: [{ name: "Unit tests", conclusion: "SUCCESS" }, { name: "Browser checks", status: "IN_PROGRESS" }] }, observed_at: "2026-11-05T08:00:00Z", stale: false, loading: false, error: null });
const shim = `<script>${outputDemo ? "Date.now=()=>1793865600000;" : singleUnit ? `Date.now=()=>${Date.parse(ledger.updated_at)};` : ""}window.fetch=async(input,options)=>options?.method==="POST"&&String(input).includes("api/execution-profile")?new Response(JSON.stringify({message:"静态预览不会保存配置"}),{status:405}):new Response(String(input).includes("api/execution-profile")?${JSON.stringify(profileDemo)}:String(input).includes("api/preferences")?${JSON.stringify(preferences)}:String(input).includes("api/resource-details")?${JSON.stringify(prDemo)}:JSON.stringify(${response}),{headers:{"Content-Type":"application/json"}});window.EventSource=class{listeners={};constructor(){window.demoOutputUpdate=(taskId,text)=>{const state=${response};const task=state.view.tasks.find(t=>t.id===taskId);const output={...task.latest_agent_output,text,state:"available",stale:false};this.revision=(this.revision??1)+1;for(const handler of this.listeners["agent-output"]??[])handler({data:JSON.stringify({output_epoch:"static-demo",output_revision:this.revision,outputs:Object.fromEntries([...state.view.tasks.map(t=>[t.id,t.id===taskId?output:t.latest_agent_output]),...state.view.groups.map(g=>["group:"+g.id,g.latest_agent_output])])})});};}addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);if(type==="open")queueMicrotask(()=>handler(new Event("open")));}close(){}};${archiveShim}document.addEventListener("DOMContentLoaded",()=>{if(new URLSearchParams(location.search).has("evidence")){const observer=new MutationObserver(()=>{const card=document.querySelector('[data-task-id="ledger"]');if(card){observer.disconnect();requestAnimationFrame(()=>card.scrollIntoView({block:"center"}));}});observer.observe(document.body,{childList:true,subtree:true});}const d=document.getElementById("details-content");new MutationObserver(()=>{for(const a of d.querySelectorAll("a")){const href=a.getAttribute("href");if(href&&href.startsWith("api/document/"))a.setAttribute("href","demo-documents/"+href.slice(13)+".html")}}).observe(d,{childList:true,subtree:true})});</script>`;
const source = readFileSync(join(output, "index.html"), "utf8");
const css = 'href="assets/app.css"';
const script = '<script type="module" src="assets/app.js"></script>';
if (!source.includes(css) || !source.includes(script))
  throw new Error("Dashboard template does not match the demo generator");
const template = singleUnit ? source.replace("<title>任务编排</title>", "<title>文档检索服务 · Mock 示例</title>").replace('class="product-name">任务编排</div>', 'class="product-name">Mock 编排 · 固定快照</div>') : source;
const html = template
  .replace(css, 'href="app.css"')
  .replace(script, `${shim}\n  <script defer src="app.js"></script>`);
const filename = singleUnit ? "single-delivery-unit.html" : "preview.html";
writeFileSync(join(output, filename), html);
console.log(`Demo preview built: ${join(output, filename)}`);
if (singleUnit) {
  for (const [surface, width] of [["tasks", 1440], ["graph", 2540]] as const) {
    writeFileSync(join(output, `single-delivery-unit-${surface}.html`), html.replace("</head>", `<style>body{width:${width}px;max-width:${width}px}</style></head>`));
  }
}

if (outputDemo) {
  writeFileSync(
    join(output, "output-desktop.html"),
    `<html><meta charset="utf-8"><style>body{margin:0}iframe{display:block;border:0;width:1440px;height:1000px}</style><iframe src="preview.html?tab=graph&layout=grid&selected=task%3Adashboard-ui&detail=1&state=agent_idle"></iframe></html>`,
  );
  writeFileSync(
    join(output, "output-hover.html"),
    `<html><meta charset="utf-8"><style>body{margin:0}iframe{display:block;border:0;width:1100px;height:900px}</style><iframe src="preview.html?tab=graph&layout=grid&evidence=tasks"></iframe></html>`,
  );
}

if (outputDemo) for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 393, 852]] as const) {
  writeFileSync(join(output, `resource-${name}.html`), `<html><meta charset="utf-8"><style>body{margin:0;width:${width}px}iframe{display:block;border:0;width:${width}px;height:${height}px}</style><iframe title="卡片悬浮信息演示" src="preview.html?tab=graph&layout=grid&evidence=tasks"></iframe></html>`);
}
