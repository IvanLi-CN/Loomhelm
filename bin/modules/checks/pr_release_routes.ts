import { findCard, jsonObjects, stringValue } from "./pr_release_support";

export { commandLabels, mutationTarget } from "./pr_release_command_helpers";

export const releaseDecisionCardRequiredKeys = [
  "publish_applicability",
  "components",
  "channel",
  "bump_rule",
  "predicted_version",
  "target_repo",
  "target_branch",
  "target_pr",
  "policy_source",
  "collision_policy",
] as const;

export interface DecisionState {
  seen: boolean;
  line: number;
  valid: boolean;
  blocked: boolean;
  routeAbsence: boolean;
  invalidReason: string | undefined;
  fingerprint: string | undefined;
}

export interface RouteState {
  line: number;
  repo: string;
  pr: string | undefined;
  labels: Set<string>;
  head: string | undefined;
  base: string | undefined;
}

export function decisionCardFrom(
  output: unknown,
): Record<string, unknown> | undefined {
  const objects = jsonObjects(output);
  for (const value of objects)
    if (
      value.decision_card !== undefined &&
      typeof value.decision_card === "object" &&
      value.decision_card !== null &&
      !Array.isArray(value.decision_card)
    )
      return value.decision_card as Record<string, unknown>;
  return objects.find((value) =>
    releaseDecisionCardRequiredKeys.every((key) => key in value),
  );
}
export function validateReleaseDecisionCard(card: Record<string, unknown>): {
  valid: boolean;
  reason: string;
} {
  if (
    "contract_version" in card &&
    (typeof card.contract_version !== "number" ||
      !Number.isInteger(card.contract_version) ||
      card.contract_version !== 3)
  )
    return {
      valid: false,
      reason: "unsupported release decision contract_version",
    };

  const missing = releaseDecisionCardRequiredKeys.filter(
    (key) => !(key in card),
  );
  if (missing.length)
    return { valid: false, reason: `missing=${missing.join(",")}` };

  let applicability: string;
  if (typeof card.publish_applicability === "boolean")
    applicability = card.publish_applicability ? "yes" : "no";
  else if (typeof card.publish_applicability === "string")
    applicability = card.publish_applicability.trim().toLowerCase();
  else applicability = "";
  if (!["yes", "no", "unknown", "blocked"].includes(applicability))
    return {
      valid: false,
      reason: "publish_applicability must be yes, no, unknown, or blocked",
    };

  const componentList = Array.isArray(card.components)
    ? card.components
    : undefined;
  const components =
    componentList !== undefined &&
    componentList.every(
      (component) => typeof component === "string" && Boolean(component.trim()),
    );
  if (!components)
    return {
      valid: false,
      reason: "components must be a list of non-empty names",
    };
  if (applicability === "yes" && componentList?.length === 0)
    return {
      valid: false,
      reason: "yes applicability requires at least one component",
    };

  const targetPr = card.target_pr;
  if (
    typeof targetPr === "boolean" ||
    !(
      (typeof targetPr === "number" &&
        Number.isInteger(targetPr) &&
        targetPr > 0) ||
      (typeof targetPr === "string" && Boolean(targetPr.trim()))
    )
  )
    return {
      valid: false,
      reason: "target_pr must identify a positive PR",
    };

  for (const key of releaseDecisionCardRequiredKeys.filter(
    (item) =>
      item !== "components" &&
      item !== "publish_applicability" &&
      item !== "target_pr",
  )) {
    const value = card[key];
    if (
      !(typeof value === "string" || Array.isArray(value)) ||
      (typeof value === "string" && !value.trim())
    )
      return { valid: false, reason: `${key} is empty` };
  }

  if (["unknown", "blocked"].includes(applicability)) {
    const status = stringValue(card.decision_status)?.toLowerCase();
    const reason = stringValue(card.reason);
    if (!["unknown", "blocked"].includes(status ?? "") || !reason)
      return {
        valid: false,
        reason: "unknown applicability requires blocked status and a reason",
      };
  }

  const policy = stringValue(card.policy_source)?.toLowerCase() ?? "";
  if (
    applicability === "no" &&
    ["", "none", "no-managed-route"].includes(policy)
  )
    return {
      valid: false,
      reason: "route absence cannot establish no release",
    };
  if (
    ["yes", "no"].includes(applicability) &&
    [
      "",
      "none",
      "unknown",
      "conflict",
      "conflicting",
      "ambiguous",
      "unresolved",
      "no-managed-route",
    ].includes(policy)
  )
    return {
      valid: false,
      reason:
        "missing or conflicting policy requires unknown or blocked applicability",
    };

  if (applicability === "yes") {
    const collision = stringValue(card.collision_policy)?.toLowerCase();
    if (
      !["block", "next-available", "next_available"].includes(collision ?? "")
    )
      return {
        valid: false,
        reason: "yes applicability requires an executable collision policy",
      };
    if (
      ["channel", "bump_rule", "predicted_version"].some((key) =>
        [
          "",
          "unknown",
          "blocked",
          "conflict",
          "conflicting",
          "unresolved",
        ].includes(stringValue(card[key])?.toLowerCase() ?? ""),
      )
    )
      return {
        valid: false,
        reason:
          "yes applicability requires resolved channel, bump rule, and predicted version",
      };
    if (card.contract_version === 3) {
      for (const key of ["required_preparation", "release_trigger"]) {
        const value = stringValue(card[key]);
        if (
          !value ||
          [
            "unknown",
            "blocked",
            "conflict",
            "conflicting",
            "unresolved",
          ].includes(value.toLowerCase())
        )
          return {
            valid: false,
            reason: `yes applicability requires ${key}`,
          };
      }
    }
  }
  return { valid: true, reason: "" };
}

export function decisionFrom(output: unknown): DecisionState | undefined {
  const card = decisionCardFrom(output);
  if (!card) return undefined;
  const applicability =
    typeof card.publish_applicability === "boolean"
      ? card.publish_applicability
        ? "yes"
        : "no"
      : (stringValue(card.publish_applicability)?.toLowerCase() ?? "");
  const validation = validateReleaseDecisionCard(card);
  const policy = stringValue(card.policy_source)?.toLowerCase() ?? "";
  const blocked = ["unknown", "blocked"].includes(applicability);
  return {
    seen: true,
    line: 0,
    // A structurally complete card can still be non-actionable. Unknown or
    // blocked applicability must not authorize a merge or release handoff.
    valid: validation.valid && !blocked,
    blocked,
    routeAbsence:
      applicability === "no" &&
      ["", "none", "no-managed-route"].includes(policy),
    invalidReason: validation.valid ? undefined : validation.reason,
    fingerprint: JSON.stringify(card),
  };
}

export function routeFrom(
  output: unknown,
): Omit<RouteState, "line"> | undefined {
  const card = findCard(
    output,
    (value) =>
      "pre_merge_release_route" in value &&
      ("route_source" in value || "policy_source" in value),
  );
  if (!card) return undefined;
  const repo = stringValue(card.target_repo)?.toLowerCase();
  const source = stringValue(
    card.route_source ?? card.policy_source,
  )?.toLowerCase();
  const route = stringValue(card.pre_merge_release_route);
  const prValue = card.target_pr;
  const pr =
    prValue === null
      ? undefined
      : /^[1-9]\d*$/.test(String(prValue))
        ? String(prValue)
        : "invalid";
  const repoFacts = stringValue(
    card.current_repository_facts ?? card.repository_facts,
  );
  const prFacts = stringValue(card.current_pr_facts ?? card.pr_facts);
  const labels = Array.isArray(card.managed_release_labels)
    ? new Set(
        card.managed_release_labels
          .filter(
            (item): item is string =>
              typeof item === "string" && Boolean(item.trim()),
          )
          .map((item) => item.trim()),
      )
    : new Set<string>();
  const noOpen = Boolean(
    prFacts &&
    /no\s+(?:open\s+)?(?:PR|pull\s+request)|(?:没有|不存在|未找到|尚无).{0,12}(?:PR|pull\s+request)/i.test(
      prFacts,
    ),
  );
  const factsHead = prFacts?.match(/(?:head|头)\s*[:=]\s*([\w.-]+)/i)?.[1];
  const factsBase = prFacts?.match(/(?:base|基线)\s*[:=]\s*([\w.-]+)/i)?.[1];
  const head = factsHead ?? stringValue(card.target_head);
  const base = factsBase ?? stringValue(card.target_base);
  const exactNullFacts =
    noOpen &&
    !/another|different|另一个|其他/i.test(prFacts ?? "") &&
    typeof card.target_head === "string" &&
    typeof card.target_base === "string" &&
    factsHead === card.target_head &&
    factsBase === card.target_base;
  const validRoute =
    source === "none"
      ? route === "no-managed-route"
      : ["repository-contract", "project-policy"].includes(source ?? "") &&
        Boolean(route) &&
        !["unknown", "no-managed-route"].includes(route ?? "");
  const validTarget = Boolean(repo && /^[^/\s]+\/[^/\s]+$/.test(repo));
  const validPr =
    prValue === null
      ? exactNullFacts
      : pr !== "invalid" &&
        Boolean(
          pr &&
          prFacts &&
          new RegExp(`(?:PR|pull\\s+request)\\s*#\\s*${pr}\\b`, "i").test(
            prFacts,
          ),
        );
  if (
    !validRoute ||
    !validTarget ||
    !repoFacts ||
    !prFacts ||
    !validPr ||
    (source === "none" && labels.size)
  )
    return undefined;
  return { repo: repo!, pr, labels, head, base };
}

export function routeFactsFrom(output: unknown):
  | {
      head: string | undefined;
      base: string | undefined;
    }
  | undefined {
  for (const card of jsonObjects(output)) {
    const facts = stringValue(card.current_pr_facts ?? card.pr_facts);
    if (!facts) continue;
    const head = facts.match(/(?:head|头)\s*[:=]\s*([\w.-]+)/i)?.[1];
    const base = facts.match(/(?:base|基线)\s*[:=]\s*([\w.-]+)/i)?.[1];
    if (head || base) return { head, base };
  }
  return undefined;
}

export function routeIsStale(
  route: RouteState,
  facts: { head: string | undefined; base: string | undefined },
): boolean {
  return Boolean(
    (route.head &&
      facts.head &&
      route.head.toLowerCase() !== facts.head.toLowerCase()) ||
    (route.base &&
      facts.base &&
      route.base.toLowerCase() !== facts.base.toLowerCase()),
  );
}
