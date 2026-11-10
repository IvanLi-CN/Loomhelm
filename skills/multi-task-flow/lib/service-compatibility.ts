import { existsSync, readdirSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";
import { ServiceState } from "../lib/service-state";
import { verifyRelease, digest } from "../lib/service-release";
import { ledgerContract, type ReleaseManifest } from "../lib/service-contract";
import { validateLedger } from "../lib/schema";
import { ContractError, requireCondition } from "../lib/errors";
import { stable } from "../lib/store-migration";

const readerCache = new Map<string, { ok: true; contract: string; revision: number } | { ok: false; code: string }>();

function releaseReader(
  releaseRoot: string,
  ledger: unknown,
): { ok: true; contract: string; revision: number } | { ok: false; code: string } {
  const cacheKey = `${releaseRoot}:${digest(stable(ledger))}`;
  const cached = readerCache.get(cacheKey);
  if (cached) return cached;
  try {
    const result = spawnSync(
      join(releaseRoot, "viewer"), ["reader-check", "--input", "-"],
      {
        input: JSON.stringify({ ledger }), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "" },
      },
    );
    if (result.status !== 0) {
      const failure = { ok: false as const, code: "LEDGER_UNREADABLE" };
      readerCache.set(cacheKey, failure);
      return failure;
    }
    const parsed = z.object({
      ok: z.literal(true),
      code: z.literal("OK"),
      result: z.object({ contract: z.string().min(1), revision: z.number().int().nonnegative() }).strict(),
    }).strict().parse(JSON.parse(result.stdout.toString()));
    const expectedContracts = new Set<string>([ledgerContract(ledger)]);
    try {
      const normalized = structuredClone(ledger);
      validateLedger(normalized);
      expectedContracts.add(ledgerContract(normalized));
    } catch {}
    const expectedRevision = z.number().int().nonnegative().parse((ledger as { revision?: unknown }).revision);
    if (!expectedContracts.has(parsed.result.contract) || parsed.result.revision !== expectedRevision) {
      const failure = { ok: false as const, code: "LEDGER_UNREADABLE" };
      readerCache.set(cacheKey, failure);
      return failure;
    }
    const success = { ok: true as const, contract: parsed.result.contract, revision: parsed.result.revision };
    readerCache.set(cacheKey, success);
    return success;
  } catch {
    const failure = { ok: false as const, code: "LEDGER_UNREADABLE" };
    readerCache.set(cacheKey, failure);
    return failure;
  }
}
function releaseRootFor(state: ServiceState, manifest: ReleaseManifest, preferred?: string): string | null {
  for (const root of [
    preferred,
    join(state.paths.releases, manifest.build_id),
    join(state.paths.candidates, manifest.build_id),
  ].filter((value): value is string => Boolean(value))) {
    try {
      const verified = verifyRelease(root);
      if (verified.build_id !== manifest.build_id) continue;
      return root;
    } catch {}
  }
  return null;
}
function releaseReadOnlyView(root: string, ledger: unknown): boolean {
  try {
    const result = spawnSync(join(root, "viewer"), ["read-only-view", "--input", "-"], {
      input: JSON.stringify({ ledger }), encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "" },
    });
    if (result.status !== 0) return false;
    const parsed = z.object({ ok: z.literal(true), code: z.literal("OK"), result: z.object({ view: z.record(z.string(), z.unknown()) }).strict() }).strict().parse(JSON.parse(result.stdout.toString()));
    const view = parsed.result.view as { orchestration?: { id?: unknown; revision?: unknown } };
    if (view.orchestration?.id !== (ledger as { orchestration_id?: unknown }).orchestration_id || view.orchestration?.revision !== (ledger as { revision?: unknown }).revision) return false;
    return true;
  } catch { return false; }
}

export const downgradeApproval = z
  .object({
    report_digest: z.string().regex(/^[a-f0-9]{64}$/),
    approval_ref: z.string().trim().min(1),
    maintenance_thread_id: z.string().trim().min(1),
  })
  .strict();
export type DowngradeApproval = z.infer<typeof downgradeApproval>;
export function compatibilityReport(
  state: ServiceState,
  target: ReleaseManifest,
  targetRoot?: string,
) {
  const current = existsSync(join(state.paths.config, "service.json"))
    ? verifyRelease(join(state.paths.releases, state.config().current_build))
    : null;
  const errors: { run_id: string; capability: string; code: string }[] = [];
  const runs: {
    run_id: string;
    contract: string | null;
    revision: number | null;
    ledger_sha256: string | null;
    current_readable: boolean;
    current_writable: boolean;
    target_readable: boolean;
    target_writable: boolean;
    fallback_build_id: string | null;
    fallback_readable: boolean;
    custom_view_sha256: string | null;
    migration_guides: string[];
  }[] = [];
  const root = join(state.paths.data, "runs");
  const releaseWindowErrors: { run_id: string; capability: string; code: string }[] = [];
  if (existsSync(state.paths.releases)) {
    const prior = readdirSync(state.paths.releases, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => { try { return verifyRelease(join(state.paths.releases, entry.name)); } catch { return null; } })
      .filter((manifest): manifest is ReleaseManifest => Boolean(manifest) && manifest.schema_version === 2 && manifest.build_id !== target.build_id)
      .sort((left, right) => right.service_version.localeCompare(left.service_version))
      .slice(0, 4);
    for (const release of prior) {
      for (const contract of release.writable) {
        if (!target.readable.includes(contract)) releaseWindowErrors.push({ run_id: `release:${release.service_version}`, capability: "release_window", code: "INCOMPATIBLE_RELEASE_WINDOW" });
      }
    }
  }
  errors.push(...releaseWindowErrors);
  if (existsSync(root))
    for (const entry of readdirSync(root, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const row = {
        run_id: entry.name,
        contract: null as string | null,
        revision: null as number | null,
        ledger_sha256: null as string | null,
        current_readable: false,
        current_writable: false,
        target_readable: false,
        target_writable: false,
        fallback_build_id: null as string | null,
        fallback_readable: false,
        custom_view_sha256: null as string | null,
        migration_guides: [] as string[],
      };
      runs.push(row);
      try {
        requireCondition(
          entry.isDirectory(),
          "UNSAFE_PATH",
          "Run must be a directory",
        );
        const bytes = readRegularNoFollow(
          join(root, entry.name, "ledger.json"),
          state.paths.root,
          undefined,
          256 * 1024 * 1024,
        );
        row.ledger_sha256 = digest(bytes);
        const raw = JSON.parse(bytes.toString("utf8"));
        row.contract = ledgerContract(raw);
        row.revision = raw.revision ?? null;
        requireCondition(
          raw.orchestration_id === entry.name,
          "RUN_MISMATCH",
          "Run identity mismatch",
        );
        // Validate the complete shape locally before asking each release to
        // prove that its own reader can consume the exact raw ledger.
        validateLedger(raw);
        const currentRoot = current ? releaseRootFor(state, current) : null;
        const currentReader = current && currentRoot
          ? releaseReader(currentRoot, raw)
          : { ok: false as const, code: "NO_CURRENT_RELEASE" };
        row.current_readable = currentReader.ok && current?.readable.includes(row.contract) === true;
        row.current_writable =
          current?.writable.includes(row.contract) ?? false;
        const targetReleaseRoot = releaseRootFor(state, target, targetRoot);
        const targetReader = target.readable.includes(row.contract) && targetReleaseRoot
          ? releaseReader(targetReleaseRoot, raw)
          : { ok: false as const, code: "INCOMPATIBLE_LEDGER" };
        row.target_readable = targetReader.ok;
        row.target_writable = target.writable.includes(row.contract);
        row.fallback_build_id = !targetReader.ok && currentReader.ok && currentRoot && releaseReadOnlyView(currentRoot, raw) ? current?.build_id ?? null : null;
        row.fallback_readable = Boolean(row.fallback_build_id);
        row.migration_guides = (target.migration_guides ?? []).filter((guide) => guide.required_for.includes(row.contract!)).map((guide) => guide.id);
        if (!row.target_readable && !row.fallback_readable)
          errors.push({
            run_id: entry.name,
            capability: "read",
            code: targetReader.ok ? "INCOMPATIBLE_LEDGER" : targetReader.code,
          });
        const custom = join(root, entry.name, "view", "view.manifest.json");
        if (lstatSync(custom, { throwIfNoEntry: false })) {
          const content = readRegularNoFollow(custom, state.paths.root);
          row.custom_view_sha256 = digest(content);
          const view = JSON.parse(content.toString("utf8"));
          if (
            !target.api_versions.includes(view.api_version) ||
            !target.frontend_contracts.includes(view.frontend_contract)
          )
            errors.push({
              run_id: entry.name,
              capability: "custom_view",
              code: "INCOMPATIBLE_VIEW",
            });
        }
      } catch (error) {
        errors.push({
          run_id: entry.name,
          capability: "read",
          code:
            error instanceof ContractError ? error.code : "LEDGER_UNREADABLE",
        });
      }
    }
  const body = {
    current_build: current?.build_id ?? null,
    target_build: target.build_id,
    runs,
    errors,
    write_downgrades: runs
      .filter((row) => row.current_writable && !row.target_writable)
      .map((row) => row.run_id),
  };
  return { ...body, report_digest: digest(stable(body)) };
}
export function requireReport(
  report: ReturnType<typeof compatibilityReport>,
  approval?: DowngradeApproval,
): void {
  if (report.errors.length)
    throw new ContractError(
      "INCOMPATIBLE_RELEASE",
      "Release cannot preserve existing run readability",
      2,
      report,
    );
  if (report.write_downgrades.length) {
    if (!approval || approval.report_digest !== report.report_digest)
      throw new ContractError(
        "WRITE_DOWNGRADE_APPROVAL_REQUIRED",
        "Confirm the exact compatibility report before losing write capability",
        3,
        report,
      );
  } else
    requireCondition(
      !approval,
      "UNEXPECTED_APPROVAL",
      "No write downgrade requires approval",
      3,
    );
}
export function selectedRelease(
  state: ServiceState,
  input: { source?: string; rollback?: boolean },
): ReleaseManifest {
  const previous = input.rollback ? state.config().previous_build : null;
  requireCondition(
    !input.rollback || previous,
    "NO_PREVIOUS_BUILD",
    "No previous build is available",
  );
  const manifest = verifyRelease(
    input.rollback ? join(state.paths.releases, previous!) : input.source!,
  );
  requireCondition(
    manifest.platform === `${process.platform}-${process.arch}`,
    "INCOMPATIBLE_PLATFORM",
    "Release does not match this platform",
  );
  return manifest;
}
