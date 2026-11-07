import { escapeRegExp } from "./markdown";
import { type BatchMap } from "./orchestration";
import {
  BATCH_DISPLAY_LABELS,
  PROJECTION_HEADINGS,
  type Finding,
  markdownCode,
  markdownText,
  mermaidText,
  safeMermaidId,
} from "./projection_base";
import { pythonStrip } from "./orchestration";

export function projectionSectionBody(
  projection: string,
  heading: string,
): string {
  const start = projection.search(new RegExp(`^## \\d+\\. ${heading}$`, "m"));
  if (start < 0) return "";
  const bodyStart = projection.indexOf("\n", start) + 1;
  const next = projection.slice(bodyStart).search(/^## \d+\. /m);
  return projection.slice(bodyStart, next < 0 ? undefined : bodyStart + next);
}

const ACCEPTANCE_CARD_HEADING =
  /^####\s+(?<fence>`+)(?<id>[^`\n]+)\k<fence>\s*$/gm;
const ACCEPTANCE_TABLE_HEADER =
  /^\s*\|?\s*[^|\n]+(?:\s*\|\s*[^|\n]+){1,}\s*\|?\s*$/;
const ACCEPTANCE_TABLE_SEPARATOR =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*){1,}\|?\s*$/;

function acceptanceCardBlocks(text: string): Array<[string, string]> {
  const headings = [...text.matchAll(ACCEPTANCE_CARD_HEADING)];
  return headings.map((heading, index): [string, string] => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? text.length;
    return [heading.groups?.id ?? "", text.slice(start, end).trim()];
  });
}

function containsAcceptanceTable(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (line.split("|").length < 2 || !ACCEPTANCE_TABLE_HEADER.test(line))
      continue;
    if (ACCEPTANCE_TABLE_SEPARATOR.test(lines[index + 1]!)) return true;
  }
  return false;
}

function projectionFindingsLegacy(
  projection: string,
  batches: BatchMap,
  acceptanceIds?: Set<string>,
  expectedBatchLines?: string[],
  expectedTaskLines?: string[],
  expectedAcceptance?: string[],
): Finding[] {
  const headings = [...projection.matchAll(/^## \d+\. (.+?)\s*$/gm)].map(
    (match) => match[1],
  );
  if (JSON.stringify(headings) !== JSON.stringify(PROJECTION_HEADINGS))
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_SECTION_MISSING",
        message:
          "owner-facing projection must contain the nine sections in order",
      },
    ];
  if (
    !projection.includes("```mermaid") ||
    !projection.includes("flowchart LR")
  )
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_GRAPH_MISSING",
        message:
          "owner-facing projection must contain a Mermaid wave/dependency graph",
      },
    ];
  const graphStart = projection.indexOf("```mermaid");
  const graphEnd = projection.indexOf("```", graphStart + 10);
  const graph =
    graphStart >= 0
      ? projection.slice(graphStart, graphEnd < 0 ? undefined : graphEnd)
      : "";
  const graphFacts: string[] = [];
  const batchNodes = new Map<string, string>();
  const taskNodes = new Map<string, string>();
  for (const batch of Object.values(batches)) {
    const batchNode = safeMermaidId("batch", batch.id);
    batchNodes.set(batch.id, batchNode);
    for (const wave of batch.waves)
      for (const task of wave.tasks) {
        const node = safeMermaidId("task", task.id);
        taskNodes.set(task.id, node);
        graphFacts.push(
          `      ${node}["${mermaidText(task.id)}<br/>${mermaidText(task.fields.title ?? task.id)}"]`,
        );
      }
  }
  for (const batch of Object.values(batches))
    for (const raw of (batch.fields.depends_on ?? "none").split(",")) {
      const dependency = pythonStrip(raw);
      if (!dependency || dependency.toLowerCase() === "none") continue;
      const [identity = "", milestone] = dependency.split("/", 2);
      const source = batchNodes.get(identity.replace(/^batch:/, ""));
      if (source)
        graphFacts.push(
          `  ${source} -.->|${mermaidText(milestone ?? "depends")}| ${batchNodes.get(batch.id)}`,
        );
    }
  for (const task of Object.values(batches).flatMap((batch) =>
    batch.waves.flatMap((wave) => wave.tasks),
  ))
    for (const raw of (task.fields.depends_on ?? "none").split(",")) {
      const dependency = pythonStrip(raw);
      if (!dependency || dependency.toLowerCase() === "none") continue;
      const [identity = "", milestone] = dependency.split("/", 2);
      const label = mermaidText(milestone ?? "depends");
      const source = dependency.startsWith("batch:")
        ? batchNodes.get(identity.slice(6))
        : taskNodes.get(identity.replace(/^task:/, ""));
      const destination = taskNodes.get(task.id);
      if (source && destination)
        graphFacts.push(
          `  ${source} ${dependency.startsWith("batch:") ? "-.->" : "-->"}|${label}| ${destination}`,
        );
    }
  const missingGraphFacts = graphFacts.filter((line) => !graph.includes(line));
  if (missingGraphFacts.length)
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_GRAPH_FACT_DRIFT",
        message: `projection graph is missing canonical nodes or edges: ${missingGraphFacts.slice(0, 5).join("; ")}`,
      },
    ];
  if (/^\s*-\s+(?:batch|task):[A-Za-z0-9]/m.test(projection))
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_SECOND_MANIFEST",
        message:
          "owner-facing projection must not contain a second batch/task manifest",
      },
    ];
  const tasks = Object.values(batches).flatMap((batch) =>
    batch.waves.flatMap((wave) => wave.tasks),
  );
  const taskSection = projectionSectionBody(projection, "任务卡");
  const missing = tasks
    .map((task) => task.id)
    .filter(
      (id) =>
        !new RegExp(`^### ${escapeRegExp(markdownText(id))}\\s+·`, "m").test(
          taskSection,
        ),
    );
  if (missing.length)
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_FACT_DRIFT",
        message: `projection is missing canonical task facts: ${missing.sort().join(", ")}`,
      },
    ];
  if (
    expectedTaskLines?.some(
      (line) => line && !taskSection.split("\n").includes(line),
    )
  )
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_FACT_DRIFT",
        message: "projection task-card values differ from canonical facts",
      },
    ];

  const acceptance = projectionSectionBody(projection, "验收清单");
  if (containsAcceptanceTable(acceptance))
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_ACCEPTANCE_TABLE_FORBIDDEN",
        message:
          "owner-facing acceptance output must use cards instead of long-text tables",
      },
    ];
  const acceptanceCards = acceptanceCardBlocks(acceptance);
  const acceptanceCardIds = acceptanceCards.map(([id]) => id);
  const duplicateIds = [...new Set(acceptanceCardIds)]
    .filter(
      (id) =>
        acceptanceCardIds.filter((candidate) => candidate === id).length > 1,
    )
    .sort();
  if (duplicateIds.length)
    return [
      {
        code: "DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DUPLICATE",
        message: `projection contains duplicate acceptance cards: ${duplicateIds.join(", ")}`,
      },
    ];
  if (acceptanceIds) {
    const missingAcceptance = [...acceptanceIds].filter(
      (id) => !acceptanceCardIds.includes(id),
    );
    if (missingAcceptance.length)
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DRIFT",
          message: `projection is missing canonical acceptance items: ${missingAcceptance.sort().join(", ")}`,
        },
      ];
  }

  for (const batch of Object.values(batches)) {
    const marker = `### 批次 ${markdownCode(batch.id)}`;
    const start = projection.indexOf(marker);
    if (start < 0)
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_BATCH_FACT_DRIFT",
          message: `projection is missing canonical batch facts: ${batch.id}`,
        },
      ];
    const next = projection.indexOf("\n### ", start + marker.length);
    const block = projection.slice(start, next < 0 ? undefined : next);
    const missingFields = Object.entries(BATCH_DISPLAY_LABELS)
      .filter(
        ([field, label]) =>
          batch.fields[field] && !block.includes(`- ${label}：`),
      )
      .map(([, label]) => label);
    if (missingFields.length)
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_BATCH_FACT_DRIFT",
          message: `projection is missing canonical batch fields for ${batch.id}: ${missingFields.join(", ")}`,
        },
      ];
    const mismatched = Object.entries(BATCH_DISPLAY_LABELS)
      .filter(
        ([field, label]) =>
          batch.fields[field] &&
          !block.includes(`- ${label}：${markdownCode(batch.fields[field])}`),
      )
      .map(([, label]) => label);
    if (mismatched.length)
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_BATCH_FACT_DRIFT",
          message: `projection batch-card values differ from canonical facts for ${batch.id}: ${mismatched.join(", ")}`,
        },
      ];
  }

  if (expectedBatchLines) {
    const taskLines = taskSection.split("\n");
    const firstTaskCard = taskLines.findIndex(
      (line) => line.startsWith("### ") && line.includes(" · "),
    );
    const batchLines = new Set(
      firstTaskCard < 0 ? taskLines : taskLines.slice(0, firstTaskCard),
    );
    if (expectedBatchLines.some((line) => line && !batchLines.has(line)))
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_BATCH_FACT_DRIFT",
          message: "projection batch-card values differ from canonical facts",
        },
      ];
  }
  if (expectedAcceptance) {
    const expectedAcceptanceSection = expectedAcceptance.join("\n");
    const expectedCards = acceptanceCardBlocks(expectedAcceptanceSection);
    if (JSON.stringify(acceptanceCards) !== JSON.stringify(expectedCards))
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DRIFT",
          message: "projection acceptance cards differ from canonical facts",
        },
      ];
    const acceptanceLines = new Set(acceptance.split(/\r?\n/));
    if (expectedAcceptance.some((line) => line && !acceptanceLines.has(line)))
      return [
        {
          code: "DEV_PLAN_OWNER_VIEW_ACCEPTANCE_DRIFT",
          message: "projection acceptance values differ from canonical facts",
        },
      ];
  }
  return [];
}

export function projectionFindings(
  projection: string,
  batches: BatchMap,
  acceptanceIds?: Set<string>,
  expectedBatchLines?: string[],
  expectedTaskLines?: string[],
  expectedAcceptance?: string[],
): Finding[] {
  return projectionFindingsLegacy(
    projection,
    batches,
    acceptanceIds,
    expectedBatchLines,
    expectedTaskLines,
    expectedAcceptance,
  );
}
