import {
  eventTexts,
  finding,
  isRecord,
  parseJsonArguments,
  readJsonLines,
  result,
  type Finding,
  type JsonRecord,
  type ReplayResult,
} from "./replay";

const reviewCommand = /\bcodex\b.*\breview\b/i;
const ownershipPromise =
  /继续盯|我再盯|我先盯|我继续\s*(?:relay|poll|轮询)|只会继续\s*(?:relay|poll|轮询)|我等它收口|我不切走|等它收口后再告诉你/i;
const runningText = /正在跑|还在跑|运行中|live 任务|live task|proof .*在跑/i;
const reviewText = /review|proof/i;
const genericContinue =
  /^(?:\[\$flow-continue\]|继续(?:吧|呀|啊)?|继续(?:，|,)?(?:你自己处理(?:嘛)?|自己处理(?:嘛)?|盯着|别停|不要停)|盯着|别停|不要停|你自己处理(?:嘛)?)[。！!？?\s]*$/i;
const ownerInput =
  /授权|批准|确认|决定|改走|改为|切到|切换|换成|新的?(?:方案|路径|策略|修复)|终止当前|停止当前/i;
const waitExhausted = /等待预算耗尽/i;
const ownerDecision = /(?:需要|请).*(?:主人|你).*(?:决定|授权|确认|批准)/i;
const sessionStart = /Process running with session ID (\d+)/g;
const sessionMention = /(?:job #|session(?:\s+id)?\s*)(\d+)/gi;
const sessionExit = /Process exited with code/i;
const sessionLost =
  /Unknown process id|session (?:missing|closed)|stdin closed/i;

interface PromiseState {
  line: number;
  text: string;
  sessionIds: Set<number> | null;
}

function promiseSessions(
  text: string,
  live: Set<number>,
  kinds: Map<number, string>,
  focused: number | undefined,
): Set<number> | null {
  const mentioned = new Set<number>();
  for (const match of text.matchAll(sessionMention)) {
    const id = Number(match[1]);
    if (live.has(id)) mentioned.add(id);
  }
  if (mentioned.size) return mentioned;
  if (focused !== undefined && live.has(focused)) {
    if (!reviewText.test(text) || kinds.get(focused) === "review")
      return new Set([focused]);
  }
  if (reviewText.test(text)) {
    const reviews = [...live].filter((id) => kinds.get(id) === "review");
    if (reviews.length === 1) return new Set(reviews);
  }
  return live.size === 1 ? new Set(live) : null;
}

function isGenericContinue(text: string): boolean {
  const stripped = text.trim();
  return (
    Boolean(stripped) &&
    !stripped.startsWith("<skill>") &&
    !stripped.startsWith("# AGENTS.md instructions") &&
    !ownerInput.test(stripped) &&
    genericContinue.test(stripped)
  );
}

function isPromise(text: string): boolean {
  const stripped = text.trim();
  if (waitExhausted.test(stripped) || ownerDecision.test(stripped))
    return false;
  return ownershipPromise.test(stripped) || runningText.test(stripped);
}

export function analyzeActiveLongTask(path: string): ReplayResult {
  const findings: Finding[] = [];
  const pendingLaunches = new Map<string, string>();
  const pendingPolls = new Map<string, number>();
  const live = new Set<number>();
  const kinds = new Map<number, string>();
  let focused: number | undefined;
  let promise: PromiseState | undefined;

  for (const { line, value } of readJsonLines(path)) {
    const payload = isRecord(value.payload) ? value.payload : {};
    const { kind, role, texts } = eventTexts(value);
    const joined = texts.join("\n");
    if (kind === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const args = parseJsonArguments(payload.arguments);
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if (name === "exec_command") {
        const command = typeof args.cmd === "string" ? args.cmd : "";
        pendingLaunches.set(
          callId,
          reviewCommand.test(command) ? "review" : "other",
        );
      } else if (name === "write_stdin") {
        const raw = args.session_id;
        const session =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && /^\d+$/.test(raw)
              ? Number(raw)
              : undefined;
        if (session !== undefined) {
          pendingPolls.set(callId, session);
          focused = session;
        }
      }
      continue;
    }
    if (kind === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const launchKind = pendingLaunches.get(callId);
      pendingLaunches.delete(callId);
      for (const match of joined.matchAll(sessionStart)) {
        const id = Number(match[1]);
        live.add(id);
        kinds.set(id, launchKind ?? "other");
        focused = id;
      }
      const session = pendingPolls.get(callId);
      pendingPolls.delete(callId);
      if (
        session !== undefined &&
        (sessionExit.test(joined) || sessionLost.test(joined))
      ) {
        live.delete(session);
        kinds.delete(session);
        if (focused === session) focused = undefined;
      } else if (session !== undefined) focused = session;
      if (!live.size) promise = undefined;
      else if (
        promise?.sessionIds &&
        [...promise.sessionIds].every((id) => !live.has(id))
      )
        promise = undefined;
      continue;
    }
    if (kind !== "message") continue;
    if (role === "assistant") {
      if (waitExhausted.test(joined) || ownerDecision.test(joined)) {
        promise = undefined;
      } else if (
        isPromise(joined) &&
        (live.size > 0 || runningText.test(joined))
      ) {
        promise = {
          line,
          text: joined.replace(/\s+/g, " ").trim(),
          sessionIds: promiseSessions(joined, live, kinds, focused),
        };
      } else if (!live.size) promise = undefined;
      continue;
    }
    if (
      role === "user" &&
      isGenericContinue(joined) &&
      promise &&
      (promise.sessionIds === null ||
        [...promise.sessionIds].some((id) => live.has(id)))
    ) {
      const promised =
        promise.sessionIds === null
          ? [...live].sort((a, b) => a - b)
          : [...promise.sessionIds]
              .filter((id) => live.has(id))
              .sort((a, b) => a - b);
      findings.push(
        finding(
          "LONG_TASK_OWNERSHIP_LEAK",
          line,
          `promise_line=${promise.line} user_line=${line} live_sessions=${promised.join(",")} promise=${promise.text}`,
        ),
      );
      promise = undefined;
    }
  }
  return result(findings);
}
