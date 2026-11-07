import { MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS } from "./orchestration";
import { parseAcceptance, type AcceptanceManifest } from "./acceptance";
import { escapeHtml } from "./text";
import {
  parseOrchestration,
  pythonStrip,
  section,
  validate,
  type BatchMap,
  type TaskMap,
  type BatchRecord,
  type TaskRecord,
} from "./orchestration";
import {
  BATCH_DISPLAY_LABELS,
  acceptanceOptions,
  markdownCode,
  markdownText,
  markdownValue,
  flowItems,
  flowType,
  flowValue,
  copyBlock,
  displayDependency,
  mermaidText,
  safeMermaidId,
} from "./projection_base";

export function parseDirectFacts(plan: string): [BatchMap, TaskMap] {
  const tasks: TaskMap = {};
  const waves: Array<{ wave: number; indent: number; tasks: TaskRecord[] }> =
    [];
  let currentWave:
    { wave: number; indent: number; tasks: TaskRecord[] } | undefined;
  let taskIndex = 0;
  const taskPattern =
    /^\s*-\s+(?<executor>[^\s=\[]+)(?:\s+(?<profile>\[[^,\]]+,\s*[^\]]+\]))?\s*=>\s*(?<body>.*)\s*$/;
  const taskPrefix =
    /^\s*-\s+(?:main-agent|sub-agent:[A-Za-z0-9_-]+|task:[A-Za-z0-9_-]+)(?:\s|=>|$)/;
  for (const rawLine of section(plan, "Task Orchestration").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const wave = rawLine.match(/^\s*-\s+wave:\s*(?<wave>\d+)\s*$/);
    if (wave?.groups) {
      currentWave = { wave: Number(wave.groups.wave), indent: 0, tasks: [] };
      waves.push(currentWave);
      continue;
    }
    const match = rawLine.match(taskPattern);
    if (!match?.groups) {
      if (taskPrefix.test(rawLine))
        throw new Error("direct task line could not be projected");
      continue;
    }
    if (!currentWave) {
      currentWave = { wave: 1, indent: 0, tasks: [] };
      waves.push(currentWave);
    }
    taskIndex += 1;
    const body = match.groups.body!.trim();
    const skillBindings = [...body.matchAll(/\(skill:\s*([^)]*)\)/g)].map(
      (item) => item[1],
    );
    const skills = [
      ...skillBindings.join(" ").matchAll(/\$[A-Za-z0-9_-]+/g),
    ].map((item) => item[0]);
    const purpose = body.replace(/\s*\(skill:\s*[^)]*\)\s*/g, " ").trim();
    const task: TaskRecord = {
      id: `task-${taskIndex}`,
      batch_id: "direct",
      wave: currentWave.wave,
      fields: {
        title: match.groups.executor!,
        purpose,
        outputs: purpose,
        profile: match.groups.profile ?? "",
        depends_on: "none",
        condition: "true",
        skill: skills.join(", ") || "未声明",
        acceptance: "全局验收清单",
      },
    };
    currentWave.tasks.push(task);
    tasks[task.id] = task;
  }
  if (!waves.length) waves.push({ wave: 1, indent: 0, tasks: [] });
  const batch: BatchRecord = {
    id: "direct",
    indent: 0,
    fields: {
      mode: "direct",
      target: flowValue(plan, "delivery_target", "main"),
      depends_on: "none",
    },
    waves,
  };
  return [{ direct: batch }, tasks];
}

export function canonicalFacts(plan: string): [BatchMap, TaskMap] {
  if (flowType(plan) === "multi-task-flow") {
    validate(plan, MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS);
    return parseOrchestration(plan, MULTI_TASK_FLOW_ORCHESTRATION_OPTIONS);
  }
  return parseDirectFacts(plan);
}

export function renderGraph(batches: BatchMap, tasks: TaskMap): string[] {
  const lines = ["```mermaid", "flowchart LR"];
  const taskNodes = new Map<string, string>();
  const batchNodes = new Map<string, string>();
  for (const batch of Object.values(batches)) {
    const batchNode = safeMermaidId("batch", batch.id);
    batchNodes.set(batch.id, batchNode);
    lines.push(`  subgraph ${batchNode}["Batch ${mermaidText(batch.id)}"]`);
    for (const wave of batch.waves) {
      const waveId = safeMermaidId("wave", batch.id, String(wave.wave));
      lines.push(
        `    subgraph ${waveId}["Wave ${wave.wave}${wave.tasks.length > 1 ? " · parallel" : ""}"]`,
      );
      for (const task of wave.tasks) {
        const node = safeMermaidId("task", task.id);
        taskNodes.set(task.id, node);
        lines.push(
          `      ${node}["${mermaidText(task.id)}<br/>${mermaidText(task.fields.title ?? task.id)}"]`,
        );
      }
      lines.push("    end");
    }
    lines.push("  end");
  }
  for (const batch of Object.values(batches))
    for (const raw of (batch.fields.depends_on ?? "none").split(",")) {
      const dependency = pythonStrip(raw);
      if (!dependency || dependency.toLowerCase() === "none") continue;
      const [identity = "", milestone] = dependency.split("/", 2);
      const source = batchNodes.get(identity.replace(/^batch:/, ""));
      if (source)
        lines.push(
          `  ${source} -.->|${mermaidText(milestone ?? "depends")}| ${batchNodes.get(batch.id)}`,
        );
    }
  for (const task of Object.values(tasks))
    for (const raw of (task.fields.depends_on ?? "none").split(",")) {
      const dependency = pythonStrip(raw);
      if (!dependency || dependency.toLowerCase() === "none") continue;
      const [identity = "", milestone] = dependency.split("/", 2);
      const label = mermaidText(milestone ?? "depends");
      if (dependency.startsWith("batch:")) {
        const source = batchNodes.get(identity.slice(6));
        if (source)
          lines.push(`  ${source} -.->|${label}| ${taskNodes.get(task.id)}`);
      } else {
        const source = taskNodes.get(identity.replace(/^task:/, ""));
        if (source)
          lines.push(`  ${source} -->|${label}| ${taskNodes.get(task.id)}`);
      }
    }
  lines.push("```");
  return lines;
}

function renderDecisionCard(plan: string): string[] {
  const lines = [
    "- 目的、范围与关键决策：",
    ...copyBlock(section(plan, "Summary"), "未提供额外摘要。").map(
      (item) => `  ${item}`,
    ),
  ];
  const labels: Record<string, string> = {
    flow_type: "流程类型",
    flow_source: "流程来源",
    lock_status: "锁定状态",
    开发基线: "开发基线",
    delivery_target: "交付目标",
    review_tier: "Review 层级",
    review_rationale: "Review 理由",
    runtime_review_strategy: "运行时 Review 策略",
    review_profile_recommendation: "Review profile 建议",
    empirical_acceptance: "经验验收",
    empirical_acceptance_rationale: "经验验收理由",
    发布策略: "发布策略",
    收口条件: "收口条件",
  };
  for (const [key, rawValue] of flowItems(section(plan, "Flow Decision"))) {
    const value = key === "flow_type" ? `\`${flowType(plan)}\`` : rawValue;
    const label = Object.hasOwn(labels, key) ? labels[key]! : key;
    lines.push(`- ${markdownText(label || "决策")}：${markdownValue(value)}`);
  }
  return lines;
}

function taskLines(batches: BatchMap): string[] {
  const lines: string[] = [];
  for (const batch of Object.values(batches))
    for (const wave of batch.waves)
      for (const task of wave.tasks) {
        const fields = task.fields;
        lines.push(
          `### ${markdownText(task.id)} · ${markdownText(fields.title ?? task.id)}`,
          `- 批次与波次：${markdownCode(batch.id)} / Wave ${task.wave}`,
          `- 目的：${markdownText(fields.purpose ?? "未声明")}`,
          `- 启动条件：${displayDependency(fields.depends_on ?? "none")}`,
          `- 条件：${markdownCode(fields.condition ?? "unknown")}`,
        );
        if (task.profile)
          lines.push(
            `- Profile：${markdownCode(`${task.profile.model} + ${task.profile.thinking}`)}`,
          );
        if (fields.owned_surfaces)
          lines.push(
            `- 文件范围：${fields.owned_surfaces
              .split(",")
              .map(pythonStrip)
              .filter(Boolean)
              .map(markdownCode)
              .join(", ")}`,
          );
        if (fields.outputs)
          lines.push(`- 产出：${markdownText(fields.outputs)}`);
        if (fields.skill) lines.push(`- Skill：${markdownCode(fields.skill)}`);
        if (fields.profile)
          lines.push(`- Agent profile：${markdownCode(fields.profile)}`);
        if (fields.acceptance)
          lines.push(`- 验收绑定：${markdownText(fields.acceptance)}`);
        lines.push("");
      }
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}
export const renderTaskCards = taskLines;
export function renderBatchCards(batches: BatchMap): string[] {
  const lines: string[] = [];
  for (const batch of Object.values(batches)) {
    lines.push(`### 批次 ${markdownCode(batch.id)}`);
    for (const [field, label] of Object.entries(BATCH_DISPLAY_LABELS))
      if (batch.fields[field])
        lines.push(`- ${label}：${markdownCode(batch.fields[field])}`);
    lines.push("");
  }
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}
export function acceptanceProjectionLines(
  manifest: AcceptanceManifest,
): string[] {
  const pre = manifest.items.filter((item) => item.phase === "pre_merge");
  const post = manifest.items.filter((item) => item.phase !== "pre_merge");
  const showScope = manifest.items.some((item) => item.scope !== "plan");
  const phaseLines = (
    heading: string,
    items: typeof manifest.items,
  ): string[] => {
    const lines = [heading, ""];
    if (!items.length) {
      lines.push("- 无适用验收项。");
      return lines;
    }
    items.forEach((item, index) => {
      if (index) lines.push("");
      const trigger =
        item.phase === "post_merge"
          ? "Merge Receipt 已存在"
          : item.phase === "post_deploy"
            ? "部署身份已核验"
            : undefined;
      lines.push(`#### ${markdownCode(item.id)}`, "");
      if (showScope) lines.push(`- 归属：${markdownCode(item.scope)}`);
      if (trigger) lines.push(`- 触发点：${markdownText(trigger)}`);
      lines.push(
        `- 必须证明：${markdownText(item.target)}`,
        "- 通过条件：",
        ...item.assertions.map((assertion) => `  - ${markdownText(assertion)}`),
        "- 验证：",
        ...item.evidence.map((evidence) => `  - ${markdownCode(evidence)}`),
      );
    });
    return lines;
  };
  const lines = phaseLines("### PR 合并前验收", pre);
  lines.push("", ...phaseLines("### PR 合并后验收", post));
  return lines;
}
export function renderAcceptance(plan: string): string[] {
  return acceptanceProjectionLines(
    parseAcceptance(plan, acceptanceOptions(plan)),
  );
}
function renderCloseout(plan: string): string[] {
  const flow = Object.fromEntries(flowItems(section(plan, "Flow Decision")));
  return [
    `- Review Readiness：${markdownValue(flow.runtime_review_strategy ?? "按运行时 Review 合同判定。")}`,
    `- Review 层级与理由：${markdownValue(flow.review_tier ?? "未指定")}；${markdownValue(flow.review_rationale ?? "未指定")}。`,
    `- 经验验收：${markdownValue(flow.empirical_acceptance ?? "未指定")}；${markdownValue(flow.empirical_acceptance_rationale ?? "未指定")}。`,
    `- 发布与收口：${markdownValue(flow["发布策略"] ?? "由当前仓库事实判定")}；${markdownValue(flow["收口条件"] ?? "由当前流程判定")}。`,
    "- 最终合并、版本预期与后续发布动作仍由主人在运行时门禁中确认。",
    "",
    "### 假设与默认",
    ...copyBlock(section(plan, "Assumptions/Defaults"), "- 无额外假设。"),
  ];
}
export function renderProjection(plan: string, batches: BatchMap): string {
  const sections: string[] = [
    `# ${markdownText(plan.match(/^#\s+(.+?)\s*$/m)?.[1] ?? "Dev Plan Review")}`,
    "",
    "## 1. 决策卡",
    ...renderDecisionCard(plan),
    "",
    "## 2. 目标",
    ...copyBlock(section(plan, "Goals"), "- 未提供目标。"),
    "",
    "## 3. 不包含的工作",
    ...copyBlock(section(plan, "Non-goals"), "- 未提供排除项。"),
    "",
    "## 4. 波次与依赖",
    "图只展示 Wave、任务、同波次并行关系和 canonical facts 中声明的显式依赖。",
    "",
    ...renderGraph(
      batches,
      Object.fromEntries(
        Object.values(batches)
          .flatMap((batch) => batch.waves.flatMap((wave) => wave.tasks))
          .map((task) => [task.id, task]),
      ),
    ),
    "",
    "## 5. 执行规则",
    "- 先对 canonical raw-plan 运行 checker；checker 通过后才生成本审阅视图。",
    "- `Task Orchestration` 是唯一执行事实源；本视图只读、临时存在于当前响应，不是新的执行输入。",
    "- 任务卡、验收清单和 Mermaid 图均由同一份 canonical facts 派生，不再维护第二份 batch/task manifest。",
    "- PR 合并前验收只消费 Candidate/PR head；PR 合并后验收必须等待 Merge Receipt，部署后验收还必须绑定 deployment identity。",
    "- 历史 JSONL 不参与新 raw-plan 生成，退休的 Wave Thread 合同不再支持读取或回放。",
    "",
    "## 6. 任务卡",
    ...renderBatchCards(batches),
    "",
    ...renderTaskCards(batches),
    "",
    "## 7. 约束",
    ...copyBlock(section(plan, "Constraints"), "- 无额外约束。"),
    "",
    "## 8. 验收清单",
    ...renderAcceptance(plan),
    "",
    "## 9. Review、运行时门禁与收口",
    ...renderCloseout(plan),
  ];
  return `${sections
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
