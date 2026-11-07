import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegularNoFollow } from "../../bin/modules/visual/secure_io";
import { ServiceState } from "./service-state";
import { verifyRelease, digest } from "./service-release";
import { ledgerContract, type ReleaseManifest } from "./service-contract";
import { validateLedger } from "./schema";
import { ContractError, requireCondition } from "./errors";
import { stable } from "./store-migration";

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
    custom_view_sha256: string | null;
  }[] = [];
  const root = join(state.paths.data, "runs");
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
        custom_view_sha256: null as string | null,
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
        // Validate the complete shape; a declared discriminator alone is not readable data.
        validateLedger(raw);
        row.current_readable =
          current?.readable.includes(row.contract) ?? false;
        row.current_writable =
          current?.writable.includes(row.contract) ?? false;
        row.target_readable = target.readable.includes(row.contract);
        row.target_writable = target.writable.includes(row.contract);
        if (!row.target_readable)
          errors.push({
            run_id: entry.name,
            capability: "read",
            code: "INCOMPATIBLE_LEDGER",
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
