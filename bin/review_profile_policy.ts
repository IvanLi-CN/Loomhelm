import { readStdinUtf8 } from "./modules/core/utf8";
import {
  DIRECT_REVIEW_ESCALATION_MARKERS,
  DIRECT_REVIEW_LANE_ALIASES,
  DIRECT_REVIEW_POLICY_PROFILES,
  laneSpecificReason,
} from "./modules/flow/review-profile-policy";

const lanePattern = /\blane(?:[ _-]*name)?\s*[:=]\s*([\w.-]+)/gi;
const naturalLanePattern = /(?<!\w)([\w.-]+)\s+lane\b/gi;
const reasonPattern = /\b(?:reason|rationale)\s*[:=]\s*(.*)$/i;
const naturalReasonPattern = /\b(?:because|due\s+to)\b(.*)$/i;

function canonicalLane(value: string): string {
  const normalized = value.trim().toLowerCase();
  for (const [lane, aliases] of Object.entries(DIRECT_REVIEW_LANE_ALIASES))
    if (
      normalized === lane ||
      [...aliases].some((alias) => normalized === alias.toLowerCase())
    )
      return lane;
  return normalized;
}

function laneCandidates(line: string): Set<string> {
  const explicit = new Set<string>();
  for (const match of line.matchAll(lanePattern))
    explicit.add(canonicalLane(match[1]!));
  if (explicit.size) return explicit;
  const natural = new Set<string>();
  for (const match of line.matchAll(naturalLanePattern))
    natural.add(canonicalLane(match[1]!));
  if (natural.size) return natural;
  const lower = line.toLowerCase();
  const tokens = new Set(lower.match(/[a-z0-9]+/g) ?? []);
  for (const [lane, aliases] of Object.entries(DIRECT_REVIEW_LANE_ALIASES)) {
    if (new RegExp(`(?<![\\w-])${lane}(?![\\w-])`, "i").test(lower))
      natural.add(lane);
    if ([...aliases].some((alias) => lower.includes(alias.toLowerCase())))
      natural.add(lane);
    const laneTokens = lane
      .split(/[^a-z0-9]+/)
      .filter(
        (token) => token && !["lane", "review", "formal"].includes(token),
      );
    if (laneTokens.some((token) => tokens.has(token))) natural.add(lane);
  }
  return natural;
}

function reasonText(line: string): string {
  return (
    reasonPattern.exec(line)?.[1] ??
    naturalReasonPattern.exec(line)?.[1] ??
    line.replace(lanePattern, "")
  );
}

function hasEscalation(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const reason = reasonText(line);
    const lanes = laneCandidates(line);
    if ([...lanes].some((lane) => laneSpecificReason(lane, reason)))
      return true;
    if (
      lanePattern.test(line) &&
      DIRECT_REVIEW_ESCALATION_MARKERS.some((marker) =>
        reason.toLowerCase().includes(marker.toLowerCase()),
      ) &&
      [...lanes].some((lane) => laneSpecificReason(lane, reason))
    )
      return true;
    lanePattern.lastIndex = 0;
  }
  return false;
}

function hasCanonicalRecommendation(text: string): boolean {
  const pairs = DIRECT_REVIEW_POLICY_PROFILES.filter(({ model, effort }) =>
    new RegExp(
      `${model.replaceAll(".", "\\.")}\\s*(?:\\+|with|and|at|\\s+)\\s*${effort}(?:[^A-Za-z0-9_-]|$)`,
      "i",
    ).test(text),
  );
  const positive =
    /(?<![A-Za-z0-9_])(?:recommend(?:ed)?|use|select)(?![A-Za-z0-9_])|(?:建议使用|推荐使用|建议)/i.test(
      text,
    );
  const negative =
    /(?:do\s+not\s+(?:use|recommend)|don't\s+(?:use|recommend)|not\s+recommend(?:ed)?|unrecommend(?:ed)?|avoid\s+(?:using|recommend)|never\s+(?:use|recommend)|不使用|不要使用|避免(?:使用|推荐)|禁止使用|不得使用|不(?:建议|推荐)(?:使用)?)/i.test(
      text,
    );
  return pairs.length === 1 && positive && !negative;
}

const mode = process.argv[2];
const input = await readStdinUtf8();
if (mode === "--check-escalation")
  process.stdout.write(hasEscalation(input) ? "1\n" : "0\n");
else if (mode === "--check-recommendation")
  process.stdout.write(hasCanonicalRecommendation(input) ? "1\n" : "0\n");
else {
  process.stderr.write(
    "usage: review_profile_policy.ts --check-escalation|--check-recommendation\n",
  );
  process.exitCode = 2;
}
