import {
  HIGH_RISK_ACCEPTANCE_CLASSES,
  FlowError,
  canonicalJson,
  isRecord,
  stableHash,
} from "./common";
import { normalizeAcceptanceManifest } from "./acceptance";
import { normalizeReviewSynthesis, reviewSynthesisInput } from "./review";

export function assertReviewSynthesisIntegrity(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
  laneNames: Set<string>,
  allFindings: Set<string>,
): void {
  const raw = wave.synthesis;
  if (
    !isRecord(raw) ||
    typeof wave.synthesis_sha256 !== "string" ||
    stableHash(raw) !== wave.synthesis_sha256
  )
    throw new FlowError("review synthesis integrity is invalid");
  let synthesis: Record<string, unknown>;
  try {
    synthesis = normalizeReviewSynthesis(reviewSynthesisInput(raw));
  } catch (error) {
    throw new FlowError("review synthesis integrity is invalid", {
      cause: error,
    });
  }
  if (
    canonicalJson(Object.keys(raw).sort()) !==
    canonicalJson(Object.keys(synthesis).sort())
  )
    throw new FlowError("review synthesis integrity is invalid");
  for (const key of Object.keys(synthesis))
    if (canonicalJson(raw[key]) !== canonicalJson(synthesis[key]))
      throw new FlowError("review synthesis integrity is invalid");
  const coverage = new Set(synthesis.coverage as string[]);
  if (
    coverage.size !== laneNames.size ||
    [...laneNames].some((lane) => !coverage.has(lane))
  )
    throw new FlowError("review synthesis coverage is stale");
  const mapped = Object.keys(
    synthesis.finding_to_group as Record<string, unknown>,
  );
  if (
    mapped.length !== allFindings.size ||
    mapped.some((finding) => !allFindings.has(finding))
  )
    throw new FlowError("review synthesis finding mapping is stale");
  const synthesizedBlockers = new Set<string>();
  for (const group of synthesis.groups as Record<string, unknown>[]) {
    if (group.blocker !== true) continue;
    for (const finding of group.finding_fingerprints as string[])
      synthesizedBlockers.add(finding);
  }
  if (
    synthesizedBlockers.size !== allFindings.size ||
    [...allFindings].some((finding) => !synthesizedBlockers.has(finding))
  )
    throw new FlowError("review synthesis blocker disposition is stale");
  for (const key of [
    "blockers",
    "blocker_fingerprints",
    "scope_fingerprint",
    "finding_to_group",
    "invariants",
    "coverage",
    "conflicts",
    "conflict_dispositions",
    "acceptance",
  ])
    if (canonicalJson(wave[key]) !== canonicalJson(synthesis[key]))
      throw new FlowError("review synthesis derived fields are stale");
  validateReviewSynthesisAcceptance(ledger, wave, synthesis);
}

export function validateReviewSynthesisAcceptance(
  ledger: Record<string, unknown>,
  wave: Record<string, unknown>,
  synthesis: Record<string, unknown>,
): void {
  const acceptance = synthesis.acceptance as Record<string, unknown>[];
  const manifestValue = ledger.acceptance_manifest;
  const manifest = manifestValue
    ? normalizeAcceptanceManifest(manifestValue)
    : undefined;
  const manifestDigest = manifest ? stableHash(manifest) : null;
  if (wave.acceptance_manifest_digest !== manifestDigest)
    throw new FlowError("review synthesis acceptance manifest is stale");
  if (!manifest) {
    if (acceptance.length)
      throw new FlowError(
        "review synthesis acceptance requires a registered manifest",
      );
    return;
  }
  const expected = manifest.items.filter(
    (item) => item.gate === "validation" && item.phase === "pre_merge",
  );
  const supplied = new Map<string, Record<string, unknown>>();
  for (const item of acceptance) {
    const id = String(item.id);
    if (supplied.has(id))
      throw new FlowError("review synthesis repeats an acceptance ID");
    supplied.set(id, item);
  }
  if (
    supplied.size !== expected.length ||
    expected.some((item) => !supplied.has(item.id))
  )
    throw new FlowError(
      "review synthesis must cover every pre-merge validation acceptance ID exactly once",
    );
  const receipts = Array.isArray(ledger.receipts)
    ? (ledger.receipts as Record<string, unknown>[])
    : [];
  for (const item of expected) {
    const declared = supplied.get(item.id)!;
    const selected: Record<string, unknown>[] = [];
    for (const receiptId of declared.receipt_ids as string[]) {
      const receipt = receipts.find(
        (candidate) => candidate.receipt_id === receiptId,
      );
      if (
        !receipt ||
        receipt.kind !== "validation" ||
        receipt.exit_code !== 0 ||
        receipt.head_sha !== wave.head_sha
      )
        throw new FlowError(
          "review synthesis references stale or invalid validation evidence",
        );
      const evidence = (
        Array.isArray(receipt.acceptance_evidence)
          ? receipt.acceptance_evidence
          : []
      ).find((candidate) => {
        if (!isRecord(candidate)) return false;
        const phase = candidate.phase ?? "pre_merge";
        const candidateSha = candidate.candidate_sha ?? receipt.head_sha;
        return (
          candidate.id === item.id &&
          phase === "pre_merge" &&
          candidateSha === receipt.head_sha &&
          item.evidence.includes(String(candidate.target))
        );
      });
      if (!isRecord(evidence))
        throw new FlowError(
          "review synthesis evidence does not match its manifest item",
        );
      selected.push(evidence);
    }
    const assertionSets = selected.map(
      (evidence) => new Set(evidence.assertions as string[]),
    );
    const required = new Set(item.assertions);
    const observed = new Set<string>();
    for (const assertions of assertionSets)
      for (const assertion of assertions) observed.add(assertion);
    if (
      HIGH_RISK_ACCEPTANCE_CLASSES.has(item.category) &&
      item.mode === "direct" &&
      selected.length !== 1
    )
      throw new FlowError(
        "high-risk direct acceptance requires exactly one validation receipt",
      );
    const covered =
      item.mode === "direct"
        ? assertionSets.some((assertions) =>
            [...required].every((assertion) => assertions.has(assertion)),
          )
        : [...required].every((assertion) => observed.has(assertion));
    const computedStatus = covered
      ? "covered"
      : observed.size
        ? "partial"
        : "missing";
    if (
      declared.status !== computedStatus ||
      canonicalJson([...(declared.assertions as string[])].sort()) !==
        canonicalJson([...observed].sort())
    )
      throw new FlowError(
        "review synthesis acceptance status does not match validation evidence",
      );
    if (!covered)
      throw new FlowError("review synthesis acceptance is partial or missing");
  }
}
