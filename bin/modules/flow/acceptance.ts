import {
  ACCEPTANCE_CLASSES,
  ACCEPTANCE_GATES,
  ACCEPTANCE_MODES,
  ACCEPTANCE_PHASES,
  canonicalJson,
  FlowError,
  HIGH_RISK_ACCEPTANCE_CLASSES,
  isRecord,
  normalizeSha,
  sortedUnique,
} from "./common";
import {
  normalizeDeploymentIdentity,
  type DeploymentIdentity,
} from "./deployment";

const LEGACY_PHASE_AMBIGUITY =
  /(?:post[ _-]*(?:merge|deploy)|after[ _-]*(?:merge|deploy)|merge[ _-]*(?:receipt|sha)|(?:release|publish|deployment|deploy|observation|observe)|合并后|合并[ _-]*(?:receipt|sha)|发布|发版|部署|上线|观察|观测)/i;

export interface AcceptanceManifestItem {
  id: string;
  category: string;
  mode: string;
  gate: string;
  scope: string;
  phase: string;
  target: string;
  evidence: string[];
  assertions: string[];
}

export interface AcceptanceManifest {
  plan_digest: string;
  items: AcceptanceManifestItem[];
}

export function normalizeAcceptanceManifest(
  payload: unknown,
): AcceptanceManifest {
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 2 ||
    typeof payload.plan_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.plan_digest) ||
    !Array.isArray(payload.items) ||
    payload.items.length === 0
  )
    throw new FlowError(
      "acceptance manifest does not match the required schema",
    );
  const seen = new Set<string>();
  const items: AcceptanceManifestItem[] = [];
  for (const raw of payload.items) {
    if (!isRecord(raw))
      throw new FlowError(
        "acceptance manifest item does not match the required schema",
      );
    const required = [
      "id",
      "category",
      "mode",
      "target",
      "evidence",
      "assertions",
    ];
    const allowed = new Set([...required, "gate", "scope", "phase"]);
    if (
      !required.every((key) => Object.hasOwn(raw, key)) ||
      Object.keys(raw).some((key) => !allowed.has(key))
    )
      throw new FlowError(
        "acceptance manifest item does not match the required schema",
      );
    const legacy = !Object.hasOwn(raw, "scope") && !Object.hasOwn(raw, "phase");
    if (
      (Object.hasOwn(raw, "scope") || Object.hasOwn(raw, "phase")) &&
      (!Object.hasOwn(raw, "scope") || !Object.hasOwn(raw, "phase"))
    )
      throw new FlowError(
        "acceptance manifest scope and phase must be declared together",
      );
    const id = typeof raw.id === "string" ? raw.id : "";
    const category = typeof raw.category === "string" ? raw.category : "";
    const mode = typeof raw.mode === "string" ? raw.mode : "";
    const gate =
      typeof raw.gate === "undefined"
        ? "validation"
        : typeof raw.gate === "string"
          ? raw.gate
          : "";
    const scope =
      typeof raw.scope === "undefined"
        ? "plan"
        : typeof raw.scope === "string"
          ? raw.scope
          : "";
    const phase =
      typeof raw.phase === "undefined"
        ? "pre_merge"
        : typeof raw.phase === "string"
          ? raw.phase
          : "";
    const target = typeof raw.target === "string" ? raw.target.trim() : "";
    const evidence = stringList(raw.evidence);
    const assertions = stringList(raw.assertions);
    const legacyText = [target, ...evidence, ...assertions].join(" ");
    if (legacy && LEGACY_PHASE_AMBIGUITY.test(legacyText))
      throw new FlowError(
        `LEGACY_ACCEPTANCE_PHASE_AMBIGUOUS: ${id || "<unknown>"}`,
      );
    if (
      !/^[A-Z][A-Z0-9_-]*$/.test(id) ||
      seen.has(id) ||
      !ACCEPTANCE_CLASSES.has(category) ||
      !ACCEPTANCE_MODES.has(mode) ||
      !ACCEPTANCE_GATES.has(gate) ||
      !/^(?:plan|(?:task|batch):[A-Za-z0-9][A-Za-z0-9_.-]*)$/.test(scope) ||
      !ACCEPTANCE_PHASES.has(phase) ||
      !target ||
      !evidence.length ||
      new Set(evidence).size !== evidence.length ||
      !assertions.length ||
      new Set(assertions).size !== assertions.length
    )
      throw new FlowError("acceptance manifest item is invalid");
    if (HIGH_RISK_ACCEPTANCE_CLASSES.has(category) && mode !== "direct")
      throw new FlowError("high-risk acceptance requires direct evidence");
    seen.add(id);
    items.push({
      id,
      category,
      mode,
      gate,
      scope,
      phase,
      target,
      evidence: sortedUnique(evidence),
      assertions: sortedUnique(assertions),
    });
  }
  return {
    plan_digest: payload.plan_digest,
    items: items.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export { normalizeDeploymentIdentity } from "./deployment";
export type { DeploymentIdentity } from "./deployment";

export interface AcceptanceEvidence {
  id: string;
  phase: string;
  target: string;
  assertions: string[];
  candidate_sha?: string;
  merge_sha?: string;
  deployment_identity?: DeploymentIdentity;
}

export function normalizeAcceptanceEvidence(
  payload: unknown,
): AcceptanceEvidence[] {
  if (payload === null || payload === undefined) return [];
  if (!Array.isArray(payload))
    throw new FlowError("acceptance evidence must be a list");
  const seen = new Set<string>();
  const result: AcceptanceEvidence[] = [];
  for (const raw of payload) {
    if (
      !isRecord(raw) ||
      !["id", "target", "assertions"].every((key) => Object.hasOwn(raw, key)) ||
      Object.keys(raw).some(
        (key) =>
          !new Set([
            "id",
            "target",
            "assertions",
            "phase",
            "candidate_sha",
            "merge_sha",
            "deployment_identity",
          ]).has(key),
      )
    )
      throw new FlowError("acceptance evidence item is invalid");
    const id = typeof raw.id === "string" ? raw.id : "";
    const phase = String(raw.phase ?? "pre_merge");
    const target = typeof raw.target === "string" ? raw.target.trim() : "";
    const assertions = stringList(raw.assertions);
    const key = `${id}:${phase}`;
    if (
      !id ||
      seen.has(key) ||
      !ACCEPTANCE_PHASES.has(phase) ||
      !target ||
      !assertions.length ||
      new Set(assertions).size !== assertions.length
    )
      throw new FlowError("acceptance evidence item is invalid");
    const evidence: AcceptanceEvidence = {
      id,
      phase,
      target,
      assertions: sortedUnique(assertions),
    };
    if (raw.candidate_sha !== undefined)
      evidence.candidate_sha = normalizeSha(
        raw.candidate_sha,
        "acceptance evidence candidate_sha",
      );
    if (raw.merge_sha !== undefined)
      evidence.merge_sha = normalizeSha(
        raw.merge_sha,
        "acceptance evidence merge_sha",
      );
    if (phase !== "pre_merge" && evidence.candidate_sha)
      throw new FlowError(
        "post-merge acceptance evidence cannot carry candidate identity",
      );
    if (
      phase === "pre_merge" &&
      Object.hasOwn(raw, "phase") &&
      !evidence.candidate_sha
    )
      throw new FlowError(
        "pre_merge acceptance evidence requires candidate_sha",
      );
    if (
      phase === "pre_merge" &&
      (evidence.merge_sha || raw.deployment_identity !== undefined)
    )
      throw new FlowError(
        "pre_merge acceptance evidence cannot carry post-merge identity",
      );
    if (phase === "post_merge" && !evidence.merge_sha)
      throw new FlowError("post_merge acceptance evidence requires merge_sha");
    if (phase === "post_merge" && raw.deployment_identity !== undefined)
      throw new FlowError(
        "post_merge acceptance evidence cannot carry deployment identity",
      );
    if (
      phase === "post_deploy" &&
      (!evidence.merge_sha || raw.deployment_identity === undefined)
    )
      throw new FlowError(
        "post_deploy acceptance evidence requires merge_sha and deployment_identity",
      );
    if (raw.deployment_identity !== undefined)
      evidence.deployment_identity = normalizeDeploymentIdentity(
        raw.deployment_identity,
      );
    seen.add(key);
    result.push(evidence);
  }
  return result.sort((left, right) =>
    `${left.id}:${left.phase}`.localeCompare(`${right.id}:${right.phase}`),
  );
}

export function validateAcceptanceEvidence(
  manifestValue: unknown,
  evidence: AcceptanceEvidence[],
  options: {
    candidateSha?: string;
    mergeSha?: string;
    deploymentIdentity?: unknown;
    allowPostMerge?: boolean;
  } = {},
): void {
  if (!evidence.length) return;
  if (!manifestValue)
    throw new FlowError("acceptance evidence requires a registered manifest");
  const manifest = normalizeAcceptanceManifest(manifestValue);
  const byId = new Map(manifest.items.map((item) => [item.id, item]));
  for (const item of evidence) {
    const expected = byId.get(item.id);
    if (!expected)
      throw new FlowError("acceptance evidence references an unknown ID");
    if (expected.phase !== item.phase)
      throw new FlowError(
        "acceptance evidence phase does not match the manifest",
      );
    if (item.phase !== "pre_merge" && !options.allowPostMerge)
      throw new FlowError(
        "post-merge acceptance evidence requires a Merge Receipt",
      );
    if (item.phase === "pre_merge" && expected.gate !== "validation")
      throw new FlowError(
        "delivery acceptance cannot be covered by local validation",
      );
    if (!expected.evidence.includes(item.target))
      throw new FlowError(
        "acceptance evidence target does not match the manifest",
      );
    if (
      !item.assertions.every((assertion) =>
        expected.assertions.includes(assertion),
      )
    )
      throw new FlowError(
        "acceptance evidence assertions do not match the manifest",
      );
    if (
      item.phase === "pre_merge" &&
      options.candidateSha &&
      item.candidate_sha !== options.candidateSha.toLowerCase()
    )
      throw new FlowError(
        "pre_merge acceptance evidence must bind the candidate SHA",
      );
    if (
      item.phase !== "pre_merge" &&
      (!options.mergeSha || item.merge_sha !== options.mergeSha)
    )
      throw new FlowError(
        "post-merge acceptance evidence must bind the merge SHA",
      );
    if (item.phase === "post_deploy") {
      const actual = normalizeDeploymentIdentity(
        item.deployment_identity,
        options.mergeSha,
      );
      const expectedIdentity = normalizeDeploymentIdentity(
        options.deploymentIdentity,
        options.mergeSha,
      );
      if (canonicalJson(actual) !== canonicalJson(expectedIdentity))
        throw new FlowError(
          "post_deploy acceptance evidence must bind the deployment identity",
        );
    }
  }
}

export function assertAcceptanceAssertionsComplete(
  manifestValue: unknown,
  evidence: AcceptanceEvidence[],
  requiredIds: string[],
): void {
  const manifest = normalizeAcceptanceManifest(manifestValue);
  const required = new Set(requiredIds);
  const groups = new Map<string, Set<string>>();
  for (const item of evidence) {
    const key = `${item.id}:${item.phase}:${canonicalJson(item.deployment_identity ?? null)}`;
    const assertions = groups.get(key) ?? new Set<string>();
    for (const assertion of item.assertions) assertions.add(assertion);
    groups.set(key, assertions);
  }
  for (const item of manifest.items) {
    if (!required.has(item.id)) continue;
    const sets = [...groups.entries()]
      .filter(([key]) => key.startsWith(`${item.id}:${item.phase}:`))
      .map(([, assertions]) => assertions);
    const covered =
      item.mode === "direct"
        ? sets.some((set) =>
            item.assertions.every((assertion) => set.has(assertion)),
          )
        : item.assertions.every((assertion) =>
            sets.some((set) => set.has(assertion)),
          );
    if (!covered)
      throw new FlowError("post-merge acceptance evidence is incomplete");
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim())
    ? (value as string[])
    : [];
}
