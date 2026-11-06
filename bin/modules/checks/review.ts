import {
  eventTexts,
  finding,
  isRecord,
  parseJsonArguments,
  readJsonLines,
  result,
  type Finding,
  type ReplayResult,
} from "./replay";

const nonDirectWrapper =
  /\bsleep\b.+&&|\bnohup\b|\bpython\b.*subprocess|>\s*\/tmp\/|2>&1/i;
const directReview = /(?:^|&&\s*|;\s*|\|\|\s*)codex\b.*(?:^|\s)review(?:\s|$)/i;
const helperReview =
  /flow_receipt\.(?:ts|py)\b.*\brecord\b.*--kind\s+review(?:\s|$)/i;
const directHelper =
  /^(?:(?:python3|bun)(?:\s+run)?\s+)?[^;&|]*flow_receipt\.(?:ts|py)\b[^;&|]*\brecord\b[^;&|]*--kind\s+review(?:\s+[^;&|]*)?$/i;
const baseRef = /--base(?:-ref)?\s+([^\s'"]+)/;
const headSha = /--head-sha\s+([^\s'"]+)/;
const profile = /--review-profile\s+([^\s'"]+)/;
const waveId = /--wave-id(?:=|\s+)([^\s'"]+)/;
const lane = /--lane(?:=|\s+)([^\s'"]+)/;
const effort =
  /(?:model_reasoning_effort=(?:"|\\")?|--review-effort\s+)([a-z]+)/;
const sessionStart = /Process running with session ID (\d+)/;
const sessionExit = /Process exited with code/i;
const sessionLost =
  /Unknown process id|session (?:missing|closed)|stdin closed/i;
const waitName = /^wait(?:_agent)?$/;

interface LaunchMeta {
  line: number;
  command: string;
  workdir: string;
  base: string;
  head: string;
  profile: string;
  wave: string;
  lane: string;
  effort: string;
}

interface LiveSession {
  line: number;
  id: number;
  launch: LaunchMeta;
}

function launchMeta(
  args: Record<string, unknown>,
  line: number,
): LaunchMeta | undefined {
  const command = typeof args.cmd === "string" ? args.cmd : "";
  if (!helperReview.test(command) && !directReview.test(command))
    return undefined;
  return {
    line,
    command,
    workdir:
      typeof args.workdir === "string" && args.workdir
        ? args.workdir
        : "<unknown-workdir>",
    base: command.match(baseRef)?.[1] ?? "<unknown-base>",
    head: command.match(headSha)?.[1] ?? "<unknown-head>",
    profile: command.match(profile)?.[1] ?? "<unknown-profile>",
    wave: command.match(waveId)?.[1] ?? "<unknown-wave>",
    lane: command.match(lane)?.[1] ?? "<unknown-lane>",
    effort: command.match(effort)?.[1] ?? "<unknown-effort>",
  };
}

function key(item: LaunchMeta): string {
  return [
    item.workdir,
    item.head,
    item.base,
    item.profile,
    item.wave,
    item.lane,
    item.effort,
  ].join(":");
}

export function analyzeReviewProof(path: string): ReplayResult {
  const findings: Finding[] = [];
  const pendingLaunches = new Map<string, LaunchMeta>();
  const pendingPolls = new Map<string, number>();
  const live = new Map<number, LiveSession>();
  for (const { line, value } of readJsonLines(path)) {
    const payload = isRecord(value.payload) ? value.payload : {};
    const { kind, texts } = eventTexts(value);
    const joined = texts.join("\n");
    if (kind === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const args = parseJsonArguments(payload.arguments);
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (name === "exec_command") {
        const launch = launchMeta(args, line);
        if (launch) {
          pendingLaunches.set(callId, launch);
          if (
            !directHelper.test(launch.command.trim()) ||
            nonDirectWrapper.test(launch.command)
          )
            findings.push(
              finding(
                "NON_DIRECT_REVIEW_LAUNCH",
                line,
                `cmd=${launch.command}`,
              ),
            );
        }
      } else if (name === "write_stdin") {
        const raw = args.session_id;
        const id =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && /^\d+$/.test(raw)
              ? Number(raw)
              : undefined;
        if (id !== undefined) pendingPolls.set(callId, id);
      } else if (waitName.test(name)) {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        for (const raw of ids) {
          const id =
            typeof raw === "number"
              ? raw
              : typeof raw === "string" && /^\d+$/.test(raw)
                ? Number(raw)
                : undefined;
          if (id !== undefined && live.has(id))
            findings.push(
              finding(
                "EXEC_SESSION_WAIT_MISUSE",
                line,
                `wait_target=${id} live_session_line=${live.get(id)!.line}`,
              ),
            );
        }
      }
    } else if (kind === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const launch = pendingLaunches.get(callId);
      pendingLaunches.delete(callId);
      if (launch) {
        const match = joined.match(sessionStart);
        if (match) {
          const id = Number(match[1]);
          for (const existing of live.values())
            if (key(existing.launch) === key(launch))
              findings.push(
                finding(
                  "DUPLICATE_LIVE_REVIEW_LAUNCH",
                  line,
                  `existing_session=${existing.id}@${existing.line} new_session=${id} key=${key(launch)}`,
                ),
              );
          live.set(id, { line, id, launch });
        }
      } else {
        const id = pendingPolls.get(callId);
        pendingPolls.delete(callId);
        if (
          id !== undefined &&
          live.has(id) &&
          (sessionExit.test(joined) || sessionLost.test(joined))
        )
          live.delete(id);
      }
    }
  }
  return result(findings);
}
