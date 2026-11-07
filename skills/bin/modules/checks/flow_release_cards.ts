import { isRecord, type JsonRecord } from "./replay";
import {
  commandTargetMatches,
  repositoryFactsMatchTarget,
  type CommandTarget,
} from "./flow_release_evidence";

const noOpenPrFacts =
  /\bno\s+(?:open\s+)?(?:PR|pull\s+request)\b|\b(?:PR|pull\s+request)\s+(?:does\s+not|is\s+not|was\s+not)\s+(?:exist|found|open)\b|(?:没有|不存在|未找到|尚无).{0,12}(?:PR|pull\s+request)/i;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function own(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validPreMergeRouteCard(
  value: JsonRecord,
  prCreated: boolean,
  boundCall: boolean,
  commandTarget: CommandTarget | undefined,
): boolean {
  if (value.type !== "response_item" || !isRecord(value.payload)) return false;
  const payload = value.payload;
  if (payload.type !== "function_call_output" || !isRecord(payload.output))
    return false;
  if (!boundCall) return false;
  const output = payload.output;
  const route = output.pre_merge_release_route;
  const source = output.route_source || output.policy_source;
  const labels = output.managed_release_labels;
  if (
    !["repository-contract", "project-policy", "none"].includes(String(source))
  )
    return false;
  if (source === "none") {
    if (route !== "no-managed-route") return false;
  } else if (
    typeof route !== "string" ||
    !route.trim() ||
    ["unknown", "no-managed-route"].includes(route)
  ) {
    return false;
  }
  const targetRepo = stringValue(output.target_repo);
  if (!targetRepo || !/^[^/\s]+\/[^/\s]+$/.test(targetRepo)) return false;
  if (!own(output, "target_pr")) return false;
  const targetPr = output.target_pr;
  const prIsValid =
    (typeof targetPr === "number" &&
      Number.isInteger(targetPr) &&
      targetPr > 0) ||
    (typeof targetPr === "string" && /^[1-9][0-9]*$/.test(targetPr.trim()));
  if (targetPr === null) {
    if (prCreated) return false;
    const facts = stringValue(output.current_pr_facts);
    const head = stringValue(output.target_head);
    const base = stringValue(output.target_base);
    if (!facts || !noOpenPrFacts.test(facts) || !head || !base) return false;
    if (
      !new RegExp(
        `(?:^|[;\\s,])head(?:_sha)?\\s*[:=]\\s*${escapeRegExp(head)}(?=$|[;\\s,])`,
      ).test(facts) ||
      !new RegExp(
        `(?:^|[;\\s,])base(?:_ref)?\\s*[:=]\\s*${escapeRegExp(base)}(?=$|[;\\s,])`,
      ).test(facts)
    )
      return false;
  } else {
    if (!prIsValid) return false;
    const facts = stringValue(output.current_pr_facts);
    if (!facts || noOpenPrFacts.test(facts)) return false;
    if (
      !new RegExp(
        `(?:\\bPR\\b|\\bpull\\s+request\\b)\\s*#\\s*${escapeRegExp(String(targetPr).trim())}\\b`,
        "i",
      ).test(facts)
    )
      return false;
  }
  const normalizedTargetPr =
    typeof targetPr === "number" && Number.isInteger(targetPr) && targetPr > 0
      ? String(targetPr)
      : typeof targetPr === "string" && /^[1-9][0-9]*$/.test(targetPr.trim())
        ? targetPr.trim()
        : undefined;
  if (!commandTargetMatches(targetRepo, normalizedTargetPr, commandTarget))
    return false;
  const repositoryFacts = stringValue(output.current_repository_facts);
  const prFacts = stringValue(output.current_pr_facts);
  if (!repositoryFacts || !prFacts || !Array.isArray(labels)) return false;
  if (!repositoryFactsMatchTarget(repositoryFacts, targetRepo)) return false;
  if (labels.some((label) => typeof label !== "string" || !label.trim()))
    return false;
  return source === "none" ? labels.length === 0 : true;
}
