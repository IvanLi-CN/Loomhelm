import { linesOf, section, sectionHeadingCount } from "./markdown";
import {
  LEGACY_BATCH_FIELDS,
  LEGACY_TASK_FIELDS,
  PYTHON_WHITESPACE_CLASS,
  REQUIRED_BATCH_FIELDS,
  V2_TASK_FIELDS,
  BatchMap,
  TaskMap,
  WaveRecord,
  BatchRecord,
  ParseOrchestrationOptions,
  TaskProfile,
  TaskRecord,
  batchPattern,
  dictionary,
  field,
  hasKey,
  parseFields,
  pythonLstrip,
  pythonStrip,
  TASK_PROFILES,
  MULTI_TASK_FLOW_TASK_SKILL,
  taskPattern,
  wavePattern,
} from "./orchestration_base";

const PYTHON_WHITESPACE = `[${PYTHON_WHITESPACE_CLASS}]`;
const BATCH_BODY_MODE = new RegExp(
  `(?:^|;)${PYTHON_WHITESPACE}*mode${PYTHON_WHITESPACE}*=${PYTHON_WHITESPACE}*([^;]+)`,
);

function usesV2TaskFields(requiredTaskFields: readonly string[]): boolean {
  return (
    requiredTaskFields.length === V2_TASK_FIELDS.length &&
    requiredTaskFields.every((field, index) => field === V2_TASK_FIELDS[index])
  );
}

function parseTaskProfile(
  value: string | undefined,
  label: string,
  profileLabel: string,
  allowlist: readonly TaskProfile[],
): TaskProfile {
  if (value === undefined)
    throw new Error(
      `${label} requires an exact ${profileLabel} profile [model, thinking]`,
    );
  const parts = value.split(",").map(pythonStrip);
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new Error(`${label} profile must use [model, thinking]`);
  const [model, thinking] = parts as [string, string];
  if (
    !allowlist.some(
      (allowed) => allowed.model === model && allowed.thinking === thinking,
    )
  ) {
    const allowed = allowlist
      .map((profile) => `${profile.model} + ${profile.thinking}`)
      .join(", ");
    throw new Error(
      `${label} profile must use an exact multi-task-flow allowlist pair: ${allowed}`,
    );
  }
  return { model, thinking };
}

export function parseOrchestration(
  text: string,
  options: ParseOrchestrationOptions = {},
): [BatchMap, TaskMap] {
  const requiredBatchFields =
    options.requiredBatchFields ?? REQUIRED_BATCH_FIELDS;
  const requiredTaskFields = options.requiredTaskFields ?? V2_TASK_FIELDS;
  if (sectionHeadingCount(text, "Task Orchestration") > 1)
    throw new Error("Task Orchestration section must appear exactly once");
  const batches: BatchMap = dictionary<BatchRecord>();
  const tasks: TaskMap = dictionary<TaskRecord>();
  let currentBatch: BatchRecord | undefined;
  let currentWave: WaveRecord | undefined;
  let sawBatch = false;
  for (const [index, rawLine] of linesOf(
    section(text, "Task Orchestration"),
  ).entries()) {
    const line = pythonStrip(rawLine);
    if (!line) continue;
    const leftStripped = pythonLstrip(rawLine);
    const leading = rawLine.slice(0, rawLine.length - leftStripped.length);
    if ([...leading].some((character) => character !== " "))
      throw new Error(
        `Task Orchestration line ${index + 1} indentation must use spaces`,
      );
    const indent = leading.length;
    const batchMatch = line.match(batchPattern);
    if (batchMatch?.groups) {
      if (indent !== 0)
        throw new Error(
          `batch at Task Orchestration line ${index + 1} must be top-level`,
        );
      sawBatch = true;
      const id = batchMatch.groups.id!;
      if (hasKey(batches, id))
        throw new Error(`Task Orchestration repeats batch:${id}`);
      const bracketMode = pythonStrip(batchMatch.groups.mode ?? "");
      let body = batchMatch.groups.body ?? "";
      const bodyMode = body.match(BATCH_BODY_MODE)?.[1];
      const normalizedBodyMode =
        bodyMode === undefined ? undefined : pythonStrip(bodyMode);
      if (
        bracketMode &&
        normalizedBodyMode !== undefined &&
        normalizedBodyMode !== bracketMode
      )
        throw new Error(`batch:${id} bracket mode conflicts with body mode`);
      if (bracketMode && bodyMode === undefined)
        body = `mode=${bracketMode};${body}`;
      const allowed =
        requiredBatchFields === LEGACY_BATCH_FIELDS ||
        requiredBatchFields.every((field) =>
          LEGACY_BATCH_FIELDS.includes(
            field as (typeof LEGACY_BATCH_FIELDS)[number],
          ),
        )
          ? REQUIRED_BATCH_FIELDS
          : requiredBatchFields;
      const fields = parseFields(
        body,
        requiredBatchFields,
        `batch:${id}`,
        allowed,
      );
      if (bracketMode) fields.mode = bracketMode;
      if (
        field(fields, "mode") !== "parent-child" &&
        field(fields, "mode") !== "direct"
      )
        throw new Error(`batch:${id} mode must be parent-child or direct`);
      currentBatch = { id, indent, fields, waves: [] };
      batches[id] = currentBatch;
      currentWave = undefined;
      continue;
    }
    const waveMatch = line.match(wavePattern);
    if (waveMatch?.groups) {
      if (!currentBatch || indent !== currentBatch.indent + 2)
        throw new Error(
          `wave at Task Orchestration line ${index + 1} must be exactly one level under a batch`,
        );
      const wave = Number(waveMatch.groups.wave);
      if (currentWave && wave <= currentWave.wave)
        throw new Error(`batch:${currentBatch.id} wave numbers must increase`);
      currentWave = { wave, indent, tasks: [] };
      currentBatch.waves.push(currentWave);
      continue;
    }
    const taskMatch = line.match(taskPattern);
    if (taskMatch?.groups) {
      if (!currentBatch || !currentWave || indent !== currentWave.indent + 2)
        throw new Error(
          `task at Task Orchestration line ${index + 1} must be exactly one level under a wave`,
        );
      const id = taskMatch.groups.id!;
      if (hasKey(tasks, id))
        throw new Error(`Task Orchestration repeats task:${id}`);
      const profile = usesV2TaskFields(requiredTaskFields)
        ? parseTaskProfile(
            taskMatch.groups.profile,
            `task:${id}`,
            options.taskProfileLabel ?? "multi-task-flow",
            options.taskProfileAllowlist ?? TASK_PROFILES,
          )
        : undefined;
      const fields = parseFields(
        taskMatch.groups.body!,
        requiredTaskFields,
        `task:${id}`,
        requiredTaskFields,
        options.expectedTaskSkill ?? MULTI_TASK_FLOW_TASK_SKILL,
      );
      const task: TaskRecord = {
        id,
        batch_id: currentBatch.id,
        wave: currentWave.wave,
        fields,
      };
      if (profile) task.profile = profile;
      currentWave.tasks.push(task);
      tasks[id] = task;
      continue;
    }
    throw new Error(`invalid v2 Task Orchestration item at line ${index + 1}`);
  }
  if (!sawBatch)
    throw new Error(
      "v2 Task Orchestration requires batch -> wave -> task nesting",
    );
  for (const batch of Object.values(batches)) {
    if (!batch.waves.length)
      throw new Error(`batch:${batch.id} must contain at least one wave`);
    for (const wave of batch.waves)
      if (!wave.tasks.length)
        throw new Error(
          `batch:${batch.id} wave ${wave.wave} must contain at least one task`,
        );
    const actual = batch.waves.map((wave) => wave.wave);
    if (actual.some((wave, index) => wave !== index + 1))
      throw new Error(
        `batch:${batch.id} wave numbering must start at 1 and be continuous`,
      );
    if (batch.fields.mode === "direct") {
      const batchTasks = Object.values(tasks).filter(
        (task) => task.batch_id === batch.id,
      );
      if (
        batch.waves.length !== 1 ||
        batchTasks.length !== 1 ||
        batchTasks[0]?.wave !== 1
      )
        throw new Error(
          `direct batch:${batch.id} requires exactly one task in wave 1`,
        );
    }
  }
  if (!Object.keys(tasks).length)
    throw new Error("v2 Task Orchestration requires task items");
  return [batches, tasks];
}
