import { readFile, writeFile } from "node:fs/promises";

const skillBinding = /\(skill:[^)]+\)/;
const waveLine = /^\s*-\s*wave:\s*\d+\s*$/;
const dispatchLine = /^\s*-\s*dispatch:\s*(?:self-run|sub-agents)\s*$/;
const assignLine =
  /^\s*-\s*assign:\s*(main-agent|sub-agent:[A-Za-z0-9_.-]+|task:[A-Za-z0-9_.-]+)(?:\s+(\[[^\]]+\]))?\s*=>\s*(.+?)\s*$/;
const nestedAssignLine =
  /^(\s*)-\s*assign:\s*(main-agent|sub-agent:[A-Za-z0-9_.-]+|task:[A-Za-z0-9_.-]+)(?:\s+(\[[^\]]+\]))?\s*=>\s*(.+?)\s*$/;
const nestedTaskLine =
  /^(\s*)-\s*(main-agent|sub-agent:[A-Za-z0-9_.-]+|task:[A-Za-z0-9_.-]+)(?:\s+(\[[^\]]+\]))?\s*=>\s*(.+?)\s*$/;
const taskLine =
  /^\s*-\s*(main-agent|sub-agent:[A-Za-z0-9_.-]+|task:[A-Za-z0-9_.-]+)(?:\s+(\[[^\]]+\]))?\s*=>\s*(.+?)\s*$/;
const flowType =
  /[\x60]?flow_type[\x60]?\s*:\s*[\x60]?([^\x60\r\n]+?)[\x60]?\s*$/im;
const profileMarker =
  /\b(?:model|model_reasoning_effort|reasoning_effort|effort)\s*=\s*[A-Za-z0-9_.-]+/gi;
const modelMarker = /\bmodel\s*=\s*(gpt-[A-Za-z0-9.-]+)/i;
const effortMarker =
  /\b(?:model_reasoning_effort|reasoning_effort|effort)\s*=\s*([A-Za-z0-9_-]+)/i;
const profiles: Record<string, Set<string>> = {
  "gpt-5.6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.6-terra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6.1-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6.1-terra": new Set(["xhigh"]),
  "gpt-6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-6-astra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
};
const aliases: Record<string, string> = {
  "$fast-pr-delivery": "$fast-flow",
  "$codex-review-loop": "$review-agent",
};

function canonicalFlowType(type: string | undefined): string | undefined {
  if (type === undefined) return;
  const normalized = type
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
  return ["multi-task-flow", "multi-task", "多任务流程"].includes(normalized)
    ? "multi-task-flow"
    : normalized;
}

function sectionRange(
  text: string,
  heading: string,
): [number, number, number] | undefined {
  const expression = new RegExp("^## " + heading + "\\s*\\r?\\n", "m");
  const start = text.search(expression);
  if (start < 0) return undefined;
  const header = text.slice(start).match(expression);
  if (!header) return undefined;
  const bodyStart = start + header[0].length;
  const next = text.slice(bodyStart).search(/^## /m);
  return [start, bodyStart, next < 0 ? text.length : bodyStart + next];
}

function normalizeBindings(bindings: string[]): string | undefined {
  const unique: string[] = [];
  for (const binding of bindings) {
    const inside = binding.slice("(skill:".length, -1);
    for (const part of inside.split("+")) {
      const skill = aliases[part.trim()] ?? part.trim();
      if (skill && !unique.includes(skill)) unique.push(skill);
    }
  }
  for (const primary of [
    "$normal-flow",
    "$fast-flow",
    "$local-merge-flow",
    "$multi-task-flow",
  ]) {
    if (unique.includes(primary)) {
      const index = unique.indexOf("$project-engineering-workflow");
      if (index >= 0) unique.splice(index, 1);
    }
  }
  return unique.length ? "(skill: " + unique.join(" + ") + ")" : undefined;
}

function skillHint(text: string, type: string | undefined): string {
  if (["multi-task-flow", "multi_task_flow", "multi-task"].includes(type ?? ""))
    return "(skill: $multi-task-flow)";
  const execution = sectionRange(text, "Execution Steps");
  if (execution) {
    const bindings =
      text
        .slice(execution[0], execution[2])
        .match(new RegExp(skillBinding.source, "g")) ?? [];
    const merged = normalizeBindings(bindings);
    if (merged) return merged;
  }
  if (
    [
      "wave-thread",
      "wave_thread",
      "wave-thread-flow",
      "initiative",
      "initiative-flow",
      "initiative_flow",
      "parallel-pr",
      "parallel_pr",
      "parallelpr",
      "parallel-pr-flow",
    ].includes(type ?? "")
  )
    throw new Error(
      "Retired coordination flows cannot be migrated; create a multi-task-flow plan explicitly.",
    );
  if (["implement-only", "implement_only"].includes(type ?? ""))
    return "(skill: $implement-only-flow)";
  if (type === "normal") return "(skill: $normal-flow)";
  if (["fast-track", "fast_track", "fast-pr", "fastpr"].includes(type ?? ""))
    return "(skill: $fast-flow)";
  if (
    ["local-merge", "local_merge", "localmerge", "local-merge-flow"].includes(
      type ?? "",
    )
  )
    return "(skill: $local-merge-flow)";
  return "(skill: $implement-only-flow)";
}

function ensureSkill(task: string, hint: string): string {
  const normalized = task
    .replaceAll("$codex-review-loop", "$review-agent")
    .trim();
  return skillBinding.test(normalized) ? normalized : normalized + " " + hint;
}

function extractProfile(task: string): [string | undefined, string] {
  const markers = [...task.matchAll(profileMarker)];
  if (!markers.length) return [undefined, task];
  const first = markers[0]!;
  const firstIndex = first.index ?? 0;
  const prefix = task.slice(0, firstIndex);
  if (prefix.trim() && !/[;,]\s*$/.test(prefix)) return [undefined, task];
  let end = firstIndex + first[0].length;
  for (const marker of markers.slice(1)) {
    if (!/^[\s,;]*$/.test(task.slice(end, marker.index ?? 0)))
      return [undefined, task];
    end = (marker.index ?? 0) + marker[0].length;
  }
  const suffix = task.slice(end);
  if (!/^[\s,;]*(?:\(skill:[^)]+\))?[\s,;]*$/.test(suffix))
    return [undefined, task];
  const block = task.slice(firstIndex, end);
  const model = block.match(modelMarker)?.[1];
  const effort = block.match(effortMarker)?.[1];
  let cleaned = prefix.replace(/[\s,;]+$/, "");
  const skill = suffix.replace(/^[\s,;]+|[\s,;]+$/g, "");
  if (skill) cleaned = (cleaned + " " + skill).trim();
  return [
    model && effort ? "[" + model + ", " + effort + "]" : undefined,
    cleaned,
  ];
}

function validProfile(profile: string | undefined): string | undefined {
  if (!profile) return undefined;
  const match = profile.match(/^\[\s*([^,\]]+)\s*,\s*([^\]]+?)\s*\]$/);
  if (!match) return undefined;
  const model = match[1]!.trim();
  const effort = match[2]!.trim();
  return profiles[model]?.has(effort)
    ? "[" + model + ", " + effort + "]"
    : undefined;
}

function executor(
  executorName: string,
  profile: string | undefined,
  task: string,
): string {
  const [legacy, cleaned] = extractProfile(task);
  const selected = validProfile(profile ?? legacy);
  if (executorName === "main-agent") return executorName + " => " + cleaned;
  return (
    executorName +
    " " +
    (selected ?? "[gpt-5.6-luna, xhigh]") +
    " => " +
    cleaned
  );
}

function convertBody(body: string, hint: string): [string, boolean, string] {
  const lines = body.split(/\r?\n/);
  if (lines.some((line) => line.trim() && waveLine.test(line))) {
    let changed = false;
    const unsupported: string[] = [];
    const output = lines.map((line) => {
      const match = nestedAssignLine.exec(line) ?? nestedTaskLine.exec(line);
      if (!match) {
        if (line.trim() && !waveLine.test(line)) unsupported.push(line);
        return line;
      }
      changed = true;
      return (
        match[1] +
        "- " +
        executor(match[2]!, match[3], ensureSkill(match[4]!, hint))
      );
    });
    if (unsupported.length)
      return [
        body,
        false,
        "unsupported-existing-wave-lines:" + unsupported.length,
      ];
    return [
      output.join("\n"),
      changed,
      changed ? "normalized-existing-wave-format" : "already-wave-format",
    ];
  }
  const items: string[] = [];
  const unsupported: string[] = [];
  for (const line of lines) {
    if (!line.trim() || dispatchLine.test(line)) continue;
    const match = assignLine.exec(line) ?? taskLine.exec(line);
    if (!match) {
      unsupported.push(line);
      continue;
    }
    items.push(
      "  - " + executor(match[1]!, match[2], ensureSkill(match[3]!, hint)),
    );
  }
  if (unsupported.length)
    return [body, false, "unsupported-lines:" + unsupported.length];
  if (!items.length) return [body, false, "no-migratable-task-items"];
  return ["- wave: 1\n" + items.join("\n"), true, "migrated-to-wave-format"];
}

export function migrateText(text: string): [string, number, string[]] {
  const section = sectionRange(text, "Task Orchestration");
  const type = canonicalFlowType(text.match(flowType)?.[1]);
  if (
    [
      "wave-thread",
      "wave-thread-flow",
      "initiative",
      "initiative-flow",
      "parallel-pr",
      "parallelpr",
      "parallel-pr-flow",
    ].includes(type ?? "")
  )
    throw new Error("Retired coordination flow cannot be migrated.");
  const hint = skillHint(text, type);
  let updated = text;
  let converted = 0;
  const notes: string[] = [];
  if (section) {
    const [newBody, changed, reason] = convertBody(
      text.slice(section[1], section[2]),
      hint,
    );
    notes.push(reason);
    if (changed) converted += 1;
    updated = text.slice(0, section[1]) + newBody + text.slice(section[2]);
  }
  const execution = sectionRange(updated, "Execution Steps");
  if (execution) {
    updated = updated.slice(0, execution[0]) + updated.slice(execution[2]);
    converted += 1;
    notes.push("removed-execution-steps:1");
  }
  return [updated.replace(/\n{3,}/g, "\n\n"), converted, notes];
}

export async function processMigration(
  path: string,
  inPlace: boolean,
): Promise<number> {
  let original: string;
  try {
    original = await readFile(path, "utf8");
  } catch {
    console.error("ERROR " + path + ": file not found");
    return 1;
  }
  const [updated, converted, notes] = migrateText(original);
  if (inPlace && updated !== original) await writeFile(path, updated, "utf8");
  if (converted)
    console.log(
      "MIGRATED " +
        path +
        " changes=" +
        converted +
        " notes=" +
        notes.join(","),
    );
  else
    console.log(
      "SKIPPED " +
        path +
        " reason=" +
        (notes[0] ?? "no-task-orchestration-section"),
    );
  if (!inPlace) process.stdout.write(updated);
  return 0;
}
