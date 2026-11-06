import { stableHash } from "../../modules/flow/common";

export type BaselineRecord = {
  id: string;
  source: string;
  method: string;
  status: "pass" | "skipped" | "failed" | "unavailable" | "timeout";
  reason: string;
  command: string;
  log: string;
};

export type BaselineManifestIdentity = {
  run_id: string;
  source_revision: string;
  scenario_ids: string[];
  log_files: string[];
  log_digests: Record<string, string>;
};

export type HistoricalBaselineFixtureIdentity = {
  evidence_kind: "historical-structured-status";
  run_id: string;
  source_revision: string;
  scenario_ids: string[];
  log_files: string[];
  log_summary_digests: Record<string, string>;
};

export function baselineManifestDigest(
  manifest: BaselineManifestIdentity,
): string {
  return stableHash({
    run_id: manifest.run_id,
    source_revision: manifest.source_revision,
    scenario_ids: [...manifest.scenario_ids].sort(),
    log_files: [...manifest.log_files].sort(),
    log_digests: Object.fromEntries(
      Object.entries(manifest.log_digests).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

export function baselineRecordDigest(
  record: BaselineRecord & { evidence_digest?: unknown },
): string {
  const { evidence_digest: _evidenceDigest, ...unsigned } = record;
  return stableHash(unsigned);
}

export function baselineLogSummaryDigest(records: BaselineRecord[]): string {
  return stableHash(
    records.map((record) => baselineRecordDigest(record)).sort(),
  );
}

export function baselineFixtureLogSummaryDigests(
  records: BaselineRecord[],
): Record<string, string> {
  const grouped = new Map<string, BaselineRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.log) ?? [];
    group.push(record);
    grouped.set(record.log, group);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([log, group]) => [log, baselineLogSummaryDigest(group)]),
  );
}

export function baselineFixtureDigest(
  fixture: HistoricalBaselineFixtureIdentity,
): string {
  return stableHash({
    evidence_kind: fixture.evidence_kind,
    run_id: fixture.run_id,
    source_revision: fixture.source_revision,
    scenario_ids: [...fixture.scenario_ids].sort(),
    log_files: [...fixture.log_files].sort(),
    log_summary_digests: Object.fromEntries(
      Object.entries(fixture.log_summary_digests).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}
