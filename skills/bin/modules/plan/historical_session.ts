import { historicalDirectFindings, type ContractFinding } from "./contract";
import { section } from "./markdown";
type HistoricalMessages = {
  plans: string[];
  invalidLines: number[];
  invalidPlanLines: number[];
};

function historicalMessages(text: string): HistoricalMessages {
  const plans: string[] = [];
  const invalidLines: number[] = [];
  const invalidPlanLines: number[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      invalidLines.push(index + 1);
      continue;
    }
    const payload = (
      row as { payload?: { type?: unknown; role?: unknown; content?: unknown } }
    ).payload;
    if (payload?.type !== "message" || payload.role !== "assistant") continue;
    const content = payload.content;
    if (!Array.isArray(content)) continue;
    const values = content
      .map((item) => {
        const itemValue = item as {
          text?: unknown;
          input_text?: unknown;
          output_text?: unknown;
        };
        const value =
          itemValue.text ?? itemValue.input_text ?? itemValue.output_text;
        return typeof value === "string" ? value : "";
      })
      .join("");
    if (!values.includes("<proposed_plan>")) continue;
    if (!values.includes("</proposed_plan>")) {
      invalidPlanLines.push(index + 1);
      continue;
    }
    plans.push(values);
  }
  return { plans, invalidLines, invalidPlanLines };
}

export function historicalPlans(text: string): string[] {
  return historicalMessages(text).plans;
}

function unwrapHistoricalPlan(text: string): string {
  const lines = text.split(/\r?\n/);
  const opening = lines.findIndex((line) => line.trim() === "<proposed_plan>");
  const closing = lines.findIndex(
    (line, index) => index > opening && line.trim() === "</proposed_plan>",
  );
  return opening >= 0 && closing > opening
    ? lines.slice(opening + 1, closing).join("\n")
    : text;
}

function historicalFindings(text: string) {
  return historicalDirectFindings(text);
}

function historicalFlowLockFinding(
  session: string,
  plan: string,
): ContractFinding | undefined {
  const source = plan
    .match(/^\s*-\s*`?flow_source`?\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1]
    ?.trim();
  const type = plan
    .match(/^\s*-\s*`?flow_type`?\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1]
    ?.trim();
  if (!type || source !== "user_explicit") return undefined;
  const aliases: Record<string, string> = {
    "fast-track": "fast[- ]track|fast[- ]flow|快速流程|快车道",
    normal: "\\bnormal\\b|普通流程|普通流",
    "local-merge": "local[- ]merge|本地合并|本地收口",
    "implement-only": "implement[- ]only|仅实现|只实现",
  };
  const flowTokens = new RegExp(
    `(?:\\$${type.replaceAll("-", "[- ]")}-flow|${aliases[type] ?? `\\b${type.replaceAll("-", "[- ]")}\\b`})`,
    "i",
  );
  const previousPlanEnd = session.lastIndexOf("</proposed_plan>");
  const beforePlan =
    previousPlanEnd >= 0
      ? session.slice(previousPlanEnd + "</proposed_plan>".length)
      : session;
  const hasQuestion =
    /request_user_input|"id"\s*:\s*"flow_type"|flow_type\s*question/i.test(
      beforePlan,
    );
  const invalidFlowToken = /normal-fast-track/i.test(beforePlan);
  const scopeClarification =
    /(?:范围|scope|规划进去|补充|(?:other|其他).*(?:unchanged|不变)|(?:flow|开发基线).*(?:unchanged|不变))/i.test(
      beforePlan,
    );
  const hasExplicitAnswer =
    !invalidFlowToken && (flowTokens.test(beforePlan) || scopeClarification);
  if (!hasQuestion && !hasExplicitAnswer)
    return {
      code: "FLOW_NOT_LOCKED_BEFORE_PLAN",
      message:
        "Historical proposed_plan was emitted before a flow lock was established.",
    };
  return undefined;
}

function ownerBaselineFromText(text: string): string | undefined {
  const patterns = [
    /(?:开发基线\s*(?:使用|用|为|是)?|development\s+baseline\s*(?:is|=)?|baseline\s*(?:is|=)?|BASE_REF\s*=|base(?:\s+branch)?\s*(?:is|=))\s*`?([A-Za-z0-9][A-Za-z0-9_.\/+;!:-]*)(?:`|(?=\s|[，。,；;。"'\]}]|$))/i,
    /(?:开发基线|development\s+baseline|base(?:\s+branch)?)\s*`([^`]+)`/i,
    /基于\s*`((?:origin|upstream)\/[A-Za-z0-9][A-Za-z0-9_.\/+;:-]*|(?:main|master|trunk|develop)|[0-9a-f]{7,64})`/i,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1]?.trim();
    if (value && !/(?:^|\/)docs\/|\.md$/i.test(value))
      return value.replace(/\.+$/, "");
  }
  return undefined;
}

function normalizeBaseline(value: string): string {
  return value.replace(/^refs\/remotes\/(origin|upstream)\//, "$1/");
}

export function historicalSessionFindings(session: string): ContractFinding[] {
  const parsed = historicalMessages(session);
  const plans = parsed.plans;
  const findings: ContractFinding[] = parsed.invalidLines.map((line) => ({
    code: "HISTORICAL_JSON_INVALID",
    message: `Historical JSONL line ${line} is invalid JSON.`,
  }));
  findings.push(
    ...parsed.invalidPlanLines.map((line) => ({
      code: "HISTORICAL_PROPOSED_PLAN_INVALID",
      message: `Historical JSONL line ${line} has an unterminated proposed_plan block.`,
    })),
  );
  if (!plans.length) {
    if (
      /\b(?:继续|continue|proceed|go ahead)\b/i.test(session) &&
      !/\b(?:normal|fast[- ]track|local[- ]merge|implement[- ]only|普通流程|快车道|本地合主干|仅实现)\b/i.test(
        session,
      )
    )
      findings.push({
        code: "FLOW_QUESTION_MISSING",
        message:
          "A continuation without an explicit flow lock must ask for flow_type.",
      });
    return findings;
  }
  for (const [planIndex, plan] of plans.entries()) {
    const raw = unwrapHistoricalPlan(plan);
    const planPrefix = historicalTextBeforePlan(session, planIndex);
    const flowLockFinding = historicalFlowLockFinding(planPrefix, raw);
    if (flowLockFinding) findings.push(flowLockFinding);
    const duplicateFlowFindings = historicalDirectFindings(raw).filter(
      (item) => item.code === "DUPLICATE_FLOW_FIELD",
    );
    findings.push(...duplicateFlowFindings);
    if (
      /flow_type\s*[:=]\s*normal-fast-track/i.test(
        session.split("<proposed_plan>", 1)[0] ?? session,
      )
    )
      findings.push({
        code: "UNKNOWN_FLOW_TYPE",
        message: "The owner flow signal is not an active flow type.",
      });
    const direct = historicalFindings(raw);
    const planBaseline =
      raw.match(/^\s*-\s*开发基线\s*[：:]\s*`?([^`\n]+)`?\s*$/m)?.[1]?.trim() ??
      raw
        .match(/^\s*-\s*development_base\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1]
        ?.trim();
    const priorText = historicalTextBeforePlan(session, planIndex);
    const previousPlanEnd = priorText.lastIndexOf("</proposed_plan>");
    const currentRequest =
      previousPlanEnd >= 0
        ? priorText.slice(previousPlanEnd + "</proposed_plan>".length)
        : priorText;
    const ownerText = currentRequest;
    const ownerBaseline = ownerBaselineFromText(priorText);
    const explicitReset =
      /\$dev-plan|(?:new|newly|replan|re-plan|新的|新一轮|重新)(?:\s+(?:plan|planning)|\s*(?:规划|计划))/i.test(
        currentRequest,
      );
    const standaloneRestatement =
      planIndex > 0 &&
      !explicitReset &&
      /\b(?:normal|fast-track|local-merge|implement-only)\b/i.test(
        currentRequest,
      );
    const baselineMustPersist =
      plans.length === 1 ||
      standaloneRestatement ||
      (!explicitReset &&
        /(?:开发基线|baseline).{0,40}(?:不变|unchanged|same|保持)/i.test(
          currentRequest,
        ));
    if (
      baselineMustPersist &&
      ownerBaseline &&
      planBaseline &&
      normalizeBaseline(ownerBaseline) !== normalizeBaseline(planBaseline)
    )
      direct.push({
        code: "OWNER_BASELINE_MISMATCH",
        message: `Flow Decision 开发基线=${planBaseline} does not match owner explicit baseline=${ownerBaseline}.`,
      });
    const planSource = raw
      .match(/^\s*-\s*`?flow_source`?\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1]
      ?.trim();
    const planType = raw
      .match(/^\s*-\s*`?flow_type`?\s*:\s*`?([^`\n]+)`?\s*$/m)?.[1]
      ?.trim();
    if (planSource === "default_fast_track" && !planBaseline)
      direct.push({
        code: "MISSING_DEVELOPMENT_BASELINE",
        message: "Flow Decision must define 开发基线.",
      });
    if (
      planSource === "fallback_default" ||
      planSource === "default_fast_track"
    ) {
      const before = currentRequest;
      const explicitFlow =
        /(?:\$(?:normal|fast[- ]flow|local[- ]merge|implement[- ]only)-flow|走\s*(?:普通流程|快车道|本地合主干|仅实现)|按(?:普通流程|快车道|本地合主干|仅实现)|"text"\s*:\s*"(?:normal|fast[- ]track|local[- ]merge|implement[- ]only)"|flow_type\s*[:=]\s*(?:normal|fast[- ]track|local[- ]merge|implement[- ]only)\b)/i.test(
          before,
        );
      const flowSignals = new Set<string>();
      if (/\$(?:normal-flow)|普通流程|\bnormal\b/i.test(before))
        flowSignals.add("normal");
      if (/\$(?:fast-flow)|快车道|\bfast[- ]track\b/i.test(before))
        flowSignals.add("fast-track");
      if (/\$(?:local-merge-flow)|本地合主干|\blocal[- ]merge\b/i.test(before))
        flowSignals.add("local-merge");
      if (
        /\$(?:implement-only-flow)|仅实现|\bimplement[- ]only\b/i.test(before)
      )
        flowSignals.add("implement-only");
      const hasDevPlan = /\$dev-plan\b/i.test(before);
      const ambiguous =
        flowSignals.size > 1 ||
        (/flow_type|流程类型|同时按|锁定策略|continue|继续/i.test(before) &&
          !explicitFlow &&
          !hasDevPlan);
      if (planSource === "fallback_default" && (!explicitFlow || ambiguous))
        direct.push({
          code: "FLOW_QUESTION_MISSING",
          message:
            "The plan used a fallback flow without a standalone flow lock question and answer.",
        });
      if (planSource === "default_fast_track" && ambiguous)
        direct.push({
          code: "DEFAULT_FAST_TRACK_NOT_ALLOWED_HERE",
          message:
            "default_fast_track is not valid when flow signals are ambiguous or conflicting.",
        });
      const deliveryText = `${section(raw, "Task Orchestration")}\n${section(raw, "Acceptance & Validation")}`;
      if (
        planSource === "default_fast_track" &&
        planType === "fast-track" &&
        !/merge[- ]ready|step\s*5c\s+ready/i.test(deliveryText)
      )
        direct.push({
          code: "DEFAULT_FAST_TRACK_MISSING_MERGE_READY_STOP",
          message:
            "default_fast_track must stop at merge-ready / Step 5C Ready.",
        });
    }
    if (
      planType === "initiative" &&
      planSource === "default_initiative_complexity"
    ) {
      if (
        !/(?:at least two|至少\s*(?:2|两)|两个|independent|独立).{0,100}(?:accept|验收).{0,100}(?:merge|合并)/is.test(
          ownerText,
        )
      )
        direct.push({
          code: "DEFAULT_INITIATIVE_ELIGIBILITY_UNPROVEN",
          message: "Initiative eligibility was not proven by the owner input.",
        });
    }
    if (
      planType === "normal" &&
      /function_call_output[\s\S]{0,500}(?:快车道|fast-track)/i.test(ownerText)
    )
      direct.push({
        code: "FLOW_DECISION_MISMATCH_LOCK",
        message:
          "The plan flow_type does not match the locked owner flow answer.",
      });
    if (
      planType !== "initiative" &&
      /(?:github|codex).{0,40}(?:unavailable|不可用|不可达|not\s+available)/i.test(
        ownerText,
      )
    )
      direct.push({
        code: "INITIATIVE_PREREQUISITES_UNAVAILABLE",
        message:
          "Initiative prerequisites are unavailable and must not be silently downgraded.",
      });
    if (
      planType === "initiative" &&
      planSource === "default_initiative_complexity" &&
      !/\binitiative\b/i.test(beforePlanText(session, plan))
    )
      direct.push({
        code: "DEFAULT_INITIATIVE_INVALID_FLOW_DECISION",
        message:
          "default_initiative_complexity requires an explicit initiative decision.",
      });
    findings.push(...direct);
  }
  return findings;
}

function beforePlanText(session: string, plan: string): string {
  const index = session.indexOf(plan);
  return index >= 0
    ? session.slice(0, index)
    : (session.split("<proposed_plan>", 1)[0] ?? session);
}

function historicalTextBeforePlan(session: string, index: number): string {
  let cursor = 0;
  for (let current = 0; current <= index; current += 1) {
    const next = session.indexOf("<proposed_plan>", cursor);
    if (next < 0) return session;
    if (current === index) return session.slice(0, next);
    cursor = next + "<proposed_plan>".length;
  }
  return session;
}

export function historicalDiagnostic(path: string, text: string): string {
  const findings = historicalSessionFindings(text);
  if (!findings.length)
    return `PASS file=${path} checks=historical-compatibility\n`;
  return (
    findings
      .map(
        (item) =>
          `FINDING file=${path} idx=historical code=${item.code} msg=${item.message}`,
      )
      .join("\n") + "\n"
  );
}
