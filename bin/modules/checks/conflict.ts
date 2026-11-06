import {
  eventText,
  finding,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";

const dirty =
  /mergeable_state["'\\]?\s*[:=]\s*["'\\]?dirty|\bdirty\b|\bmerge conflict\b|冲突/i;
const absence = /workflow evidence|checks? 缺席|CI evidence|没有 workflow/i;
const owner = /请主人选择|escalat(?:e|ed) to (?:the )?owner|ask the owner/i;
const autoHeal =
  /自动解冲|auto(?:matic|matically)?(?: |-)?heal|续推|continue the merge path/i;

export function analyzeConflictReplay(path: string): ReplayResult {
  const findings: Finding[] = [];
  let conflictLine = 0;
  for (const { line, value } of readJsonLines(path)) {
    const text = eventText(value);
    if (!text) continue;
    if (dirty.test(text)) conflictLine ||= line;
    if (!conflictLine || !value.payload || value.type !== "response_item")
      continue;
    const role =
      typeof value.payload === "object" &&
      value.payload !== null &&
      !Array.isArray(value.payload)
        ? (value.payload as Record<string, unknown>).role
        : undefined;
    if (role !== "assistant") continue;
    if (absence.test(text) && !autoHeal.test(text))
      findings.push(
        finding(
          "CONFLICT_HIDDEN_AS_CI_ABSENCE",
          line,
          `conflict_line=${conflictLine} absence_line=${line}`,
        ),
      );
    if (owner.test(text) && !autoHeal.test(text))
      findings.push(
        finding(
          "CONFLICT_ESCALATED_TO_OWNER",
          line,
          `conflict_line=${conflictLine} escalation_line=${line}`,
        ),
      );
  }
  return result(
    findings.filter(
      (item, index, all) =>
        all.findIndex(
          (other) => other.code === item.code && other.line === item.line,
        ) === index,
    ),
  );
}
