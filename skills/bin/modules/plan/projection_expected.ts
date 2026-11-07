import { parseAcceptance, type AcceptanceManifest } from "./acceptance";
import { pythonStrip, type BatchMap } from "./orchestration";
import {
  BATCH_DISPLAY_LABELS,
  acceptanceOptions,
  displayDependency,
  markdownCode,
  markdownText,
} from "./projection_base";

function withoutTrailingBlank(lines: string[]): string[] {
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

export function expectedTaskCardLines(batches: BatchMap): string[] {
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
        const surfaces = fields.owned_surfaces;
        if (surfaces)
          lines.push(
            `- 文件范围：${surfaces
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
  return withoutTrailingBlank(lines);
}

export function expectedBatchCardLines(batches: BatchMap): string[] {
  const lines: string[] = [];
  for (const batch of Object.values(batches)) {
    lines.push(`### 批次 ${markdownCode(batch.id)}`);
    for (const [field, label] of Object.entries(BATCH_DISPLAY_LABELS))
      if (batch.fields[field])
        lines.push(`- ${label}：${markdownCode(batch.fields[field])}`);
    lines.push("");
  }
  return withoutTrailingBlank(lines);
}

function expectedAcceptanceProjectionLines(
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

export function expectedAcceptanceLines(plan: string): string[] {
  return expectedAcceptanceProjectionLines(
    parseAcceptance(plan, acceptanceOptions(plan)),
  );
}
