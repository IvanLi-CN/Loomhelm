import { add, type ReleaseState } from "./pr_release_state";
import { identifiersMatch, iso8601, shaMatches } from "./pr_release_support";

export function evaluatePublished(
  state: ReleaseState,
  line: number,
  message: string,
): void {
  const { target, reported, publicationFacts } = state;
  if (!target.sha)
    add(
      state.findings,
      "RELEASE_TARGET_SHA_MISSING",
      line,
      "published status requires a trusted target_sha",
    );
  if (!target.branch)
    add(
      state.findings,
      "RELEASE_TARGET_BRANCH_MISSING",
      line,
      "published status requires a trusted target_branch",
    );
  const matching = publicationFacts.filter((fact) => {
    const identityMatch = [...state.surfaceIdentities].some(
      ([surface, identities]) =>
        fact.surface === surface &&
        [...identities].some((identity) =>
          [...fact.urls].some((url) => url.includes(identity)),
        ),
    );
    return (
      identityMatch ||
      Boolean(
        !target.repo ||
        fact.repos.has(target.repo) ||
        [...fact.urls].some((url) =>
          url.toLowerCase().includes(target.repo!.toLowerCase()),
        ),
      )
    );
  });
  if (!state.expectedSurfaceSet.size)
    add(
      state.findings,
      "RELEASE_EXPECTED_SURFACES_MISSING",
      line,
      "published status lacks declared release surfaces",
    );
  const actualSurfaces = new Set(matching.map((fact) => fact.surface));
  for (const surface of state.expectedSurfaceSet)
    if (!actualSurfaces.has(surface))
      add(
        state.findings,
        "RELEASE_SURFACES_INCOMPLETE",
        line,
        `missing_surface=${surface}`,
      );
  for (const [surface, identities] of state.surfaceIdentities)
    if (
      [...identities].some(
        (identity) =>
          !matching.some(
            (fact) =>
              fact.surface === surface &&
              [...fact.urls].some((url) => url.includes(identity)),
          ),
      )
    )
      add(
        state.findings,
        "RELEASE_IDENTITIES_INCOMPLETE",
        line,
        `surface=${surface}`,
      );
  if (!publicationFacts.length)
    add(
      state.findings,
      "RELEASE_PUBLICATION_EVIDENCE_MISSING",
      line,
      "published status has no actual release evidence",
    );
  if (!publicationFacts.some((fact) => fact.shas.size))
    add(
      state.findings,
      "RELEASE_ACTUAL_SHA_EVIDENCE_MISSING",
      line,
      "published status has no actual artifact-to-merge SHA",
    );
  if (
    (target.repo && matching.length === 0) ||
    (state.epochResetMissingIdentity && !target.repo)
  )
    add(
      state.findings,
      "RELEASE_REPOSITORY_BINDING_MISMATCH",
      line,
      `target_repo=${target.repo ?? "missing"}`,
    );
  if (
    reported.tag &&
    matching.length &&
    !matching.some((fact) =>
      [...fact.tags].some((tag) => identifiersMatch(reported.tag!, tag)),
    )
  )
    add(
      state.findings,
      "RELEASE_ACTUAL_TAG_BINDING_MISMATCH",
      line,
      `reported_tag=${reported.tag}`,
    );
  if (
    state.bound &&
    matching.length &&
    !matching.some((fact) =>
      [...fact.shas].some((sha) => shaMatches(state.bound, sha)),
    )
  )
    add(
      state.findings,
      "RELEASE_ACTUAL_SHA_BINDING_MISMATCH",
      line,
      `reported_sha=${state.bound}`,
    );
  if (
    reported.tag &&
    state.bound &&
    matching.length &&
    !matching.some(
      (fact) =>
        [...fact.tags].some((tag) => identifiersMatch(reported.tag!, tag)) &&
        [...fact.shas].some((sha) => shaMatches(state.bound, sha)),
    )
  )
    add(
      state.findings,
      "RELEASE_ATOMIC_IDENTITY_MISMATCH",
      line,
      "no single publication fact matches tag and bound SHA",
    );
  if (
    reported.version &&
    matching.length &&
    !matching.some((fact) =>
      [...fact.tags].some((tag) => identifiersMatch(reported.version!, tag)),
    )
  )
    add(
      state.findings,
      "RELEASE_VERSION_BINDING_MISMATCH",
      line,
      `reported_version=${reported.version}`,
    );
  if (
    reported.url &&
    matching.length &&
    !matching.some((fact) => fact.urls.has(reported.url!))
  )
    add(
      state.findings,
      "RELEASE_URL_BINDING_MISMATCH",
      line,
      `reported_url=${reported.url}`,
    );
  if (
    reported.workflow &&
    matching.length &&
    !matching.some((fact) => fact.urls.has(reported.workflow!))
  )
    add(
      state.findings,
      "RELEASE_WORKFLOW_URL_BINDING_MISMATCH",
      line,
      `reported_workflow=${reported.workflow}`,
    );
  if (
    reported.time &&
    (!iso8601(reported.time) ||
      (matching.length &&
        !matching.some((fact) => fact.times.has(reported.time!))))
  )
    add(
      state.findings,
      "RELEASE_TIME_BINDING_MISMATCH",
      line,
      `reported_time=${reported.time}`,
    );
  if (
    state.reportContractDeclared &&
    (!/发布版本\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布tag\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布channel\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布绑定sha\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布URL\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布时间\s*[:=]\s*(?!none|未检查)\S+/i.test(message) ||
      !/发布产物\s*[:=]\s*(?!none|未检查)\S+/i.test(message))
  )
    add(
      state.findings,
      "RELEASE_METADATA_INCOMPLETE",
      line,
      "published release report is incomplete",
    );
  if (
    !state.idempotentRun &&
    state.actualRunId &&
    state.releaseRerunAttempted &&
    !state.userAuthorizedRerun
  )
    add(
      state.findings,
      "RELEASE_RERUN_SAFETY_VIOLATION",
      line,
      "rerun lacks an authorized idempotent run proof",
    );
}
