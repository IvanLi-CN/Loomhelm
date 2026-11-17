import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createDirectoryNoFollow,
  syncDirectoryNoFollow,
  writeAtomicNoFollow,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { ContractError, requireCondition } from "./errors";
import { auditMatchesSource, migrationAudit } from "./migration-audit";
import {
  identityOf,
  type RunIdentity,
  runIdentity,
  sameRunIdentity,
  upgradeState,
} from "./orchestration-identity";
import {
  assessMigration,
  checkMigration,
  readMigrationInput,
  readMigrationSnapshot,
} from "./orchestration-migration";
import { validateLedger } from "./schema";
import { type LedgerStore, withExclusiveLock } from "./store";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type UpgradeDependencies = {
  afterStage?: (phase: string) => void;
};
function requireForward(source: RunIdentity, target: RunIdentity): void {
  if (sameRunIdentity(source, target)) return;
  requireCondition(
    Bun.semver.order(target.package_version, source.package_version) > 0,
    "DOWNGRADE_FORBIDDEN",
    "Only a newer immutable package identity may be selected",
    4,
  );
  requireCondition(
    source.compatibility_line === target.compatibility_line,
    "INCOMPATIBLE_RELEASE",
    "Cross-line upgrades require a supported migration",
    4,
  );
  requireCondition(
    target.ledger_contract === 5,
    "INCOMPATIBLE_RELEASE",
    "Target must implement ledger contract 5",
    4,
  );
}
/** Read-only: does not bootstrap a binding or resolve mutable tags. */
export function inspectOrchestration(store: LedgerStore, caller: RunIdentity) {
  const { raw, binding } = readMigrationSnapshot(store);
  const source = raw.runtime_identity ?? (binding && identityOf(binding));
  return {
    run_id: raw.orchestration_id,
    contract: raw.contract_version,
    source: source ?? null,
    caller,
    upgrade: raw.upgrade ?? null,
    compatible:
      !raw.upgrade || raw.upgrade.phase === "completed"
        ? sameRunIdentity(source, caller) && sameRunIdentity(binding && identityOf(binding), caller)
        : false,
  };
}
/** The caller owns run lifecycle exclusion; the existing maintenance/ledger locks fence old writers. */
export function upgradeOrchestration(
  store: LedgerStore,
  caller: RunIdentity,
  requestedTarget: RunIdentity,
  dependencies: UpgradeDependencies = {},
  dryRun = false,
  requestedSelector = requestedTarget.package_version,
): unknown {
  const target = runIdentity.parse(requestedTarget);
  requireCondition(
    sameRunIdentity(caller, target),
    "UPGRADE_EXECUTOR_MISMATCH",
    "Use the target package CLI",
    4,
  );
  if (dryRun) {
    const report = checkMigration(store, caller, target);
    if (!report.migration_ready)
      throw new ContractError(
        "RUN_MIGRATION_UNSAFE",
        "Mechanical migration checks failed",
        4,
        report,
      );
    return { changed: false, dry_run: true, ...report };
  }
  return withExclusiveLock(join(store.runPath, "locks", "viewer-binding.lock"), () =>
    store.maintain((context) => {
      const read = (path: string) =>
        readMigrationInput(
          path,
          context.rootPath,
          path === context.ledgerPath ? context.runIdentity : undefined,
        ).content;
      const write = (path: string, content: string) =>
        writeAtomicNoFollow(
          path,
          content,
          context.rootPath,
          undefined,
          path === context.ledgerPath ? context.runIdentity : undefined,
        );
      const initialSnapshot = readMigrationSnapshot(store);
      const originalContent = initialSnapshot.content;
      const raw = JSON.parse(originalContent);
      validateLedger(raw);
      const previous = raw.upgrade ? upgradeState.parse(raw.upgrade) : null;
      const pending = previous && previous.phase !== "completed" ? previous : null;
      const bindingPath = join(store.runPath, "runtime", "viewer-binding.json");
      const bindingContent = initialSnapshot.bindingContent;
      const binding = bindingContent ? JSON.parse(bindingContent) : null;
      requireCondition(
        binding?.run_id === raw.orchestration_id,
        "SOURCE_IDENTITY_UNAVAILABLE",
        "A verified binding for this run is required; never infer it from the Gateway",
        4,
      );
      const bound = runIdentity.parse(identityOf(binding));
      const source = pending?.source ?? runIdentity.parse(raw.runtime_identity ?? bound);
      if (pending) {
        requireCondition(
          binding.schema_version === 2,
          "UPGRADE_STATE_CONFLICT",
          "Prepared upgrade requires the fenced binding format",
          4,
        );
        requireCondition(
          sameRunIdentity(pending.target, target),
          "UPGRADE_TARGET_FROZEN",
          "Resume the registered immutable target",
          4,
        );
        requireCondition(
          sameRunIdentity(bound, source)
            ? digest(JSON.stringify({ ...binding, schema_version: 1 })) ===
                pending.source_binding_digest ||
                digest(JSON.stringify(binding)) === pending.source_binding_digest
            : sameRunIdentity(bound, target) &&
                binding.request_id === pending.operation_id &&
                binding.revision === pending.source_binding_revision + 1,
          "UPGRADE_STATE_CONFLICT",
          "Binding is outside the registered upgrade",
          4,
        );
      } else {
        requireCondition(
          sameRunIdentity(bound, source),
          "UPGRADE_STATE_CONFLICT",
          "Ledger and binding disagree",
          4,
        );
        requireForward(source, target);
        if (sameRunIdentity(source, target))
          return { changed: false, identity: target, upgrade: previous };
        requireCondition(
          raw.schema_version === 2 &&
            [3, 4, 5].includes(raw.contract_version) &&
            source.ledger_contract === raw.contract_version,
          "MIGRATION_REQUIRED",
          "No verified mechanical migration is available for this source",
          4,
        );
      }
      {
        const snapshot = readMigrationSnapshot(store);
        requireCondition(
          snapshot.content === originalContent && snapshot.bindingContent === bindingContent,
          "OBSERVATION_STALE",
          "Locked source changed",
          4,
        );
        const report = assessMigration(snapshot, caller, target);
        if (!report.migration_ready)
          throw new ContractError(
            "RUN_MIGRATION_UNSAFE",
            "Mechanical migration checks failed",
            4,
            report,
          );
        let state = pending;
        const commit = (phase: "prepared" | "migrated" | "binding_switched" | "completed") => {
          raw.upgrade = { ...state!, phase };
          raw.revision += 1;
          raw.updated_at = new Date().toISOString();
          validateLedger(raw);
          write(context.ledgerPath, JSON.stringify(raw, null, 2) + "\n");
          state = raw.upgrade;
          dependencies.afterStage?.(phase);
        };
        if (!state) {
          const sourceDigest = digest(originalContent);
          const backup = `upgrade-${sourceDigest}.json`;
          const backupPath = join(store.runPath, backup);
          if (!existsSync(backupPath))
            writeExclusiveNoFollow(
              backupPath,
              originalContent,
              context.rootPath,
              context.runIdentity,
            );
          syncDirectoryNoFollow(store.runPath, context.rootPath, context.runIdentity);
          requireCondition(
            digest(read(backupPath)) === sourceDigest,
            "UPGRADE_BACKUP_INVALID",
            "Source backup does not match the locked ledger",
            5,
          );
          state = {
            operation_id: `upgrade-${digest(JSON.stringify({ source, target, sourceDigest }))}`,
            source,
            target,
            source_revision: raw.revision,
            source_digest: sourceDigest,
            source_directory: `.upgrade-${randomUUID()}`,
            source_binding_revision: binding.revision,
            source_binding_digest: digest(JSON.stringify(binding)),
            requested_selector: requestedSelector,
            backup,
            phase: "prepared",
            migration_audit: migrationAudit.parse({
              schema_version: 1,
              policy: "preserve-unresolved-v1",
              validator_version: 1,
              source_contract: raw.contract_version,
              source_revision: raw.revision,
              source_digest: sourceDigest,
              source_binding_digest: digest(JSON.stringify(binding)),
              source_call_digest: report.source_call_digest,
              business_digest: report.business_digest,
              unresolved_digest: report.unresolved_digest,
              unresolved: report.unresolved,
              writer_barrier: "ledger-contract-5-and-binding-schema-2",
              native_quiescence: "not_asserted",
            }),
          };
          raw.contract_version = 5;
          raw.runtime_identity = source;
          raw.upgrade = state;
          raw.revision += 1;
          raw.updated_at = new Date().toISOString();
          validateLedger(raw);
          store.publishUpgrade(
            context,
            raw,
            { ...binding, schema_version: 2 },
            state.source_directory,
            dependencies.afterStage,
          );
          dependencies.afterStage?.("prepared");
        }
        const backupContent = read(join(store.runPath, state!.backup));
        requireCondition(
          digest(backupContent) === state!.source_digest,
          "UPGRADE_BACKUP_INVALID",
          "Upgrade backup does not match the registered source",
          5,
        );
        const sourceDirectory = join(dirname(store.runPath), state!.source_directory);
        const sourceCallPath = join(sourceDirectory, "runtime", "call.json");
        requireCondition(
          auditMatchesSource(raw, state, {
            backup: backupContent,
            ledger: read(join(sourceDirectory, "ledger.json")),
            binding: read(join(sourceDirectory, "runtime", "viewer-binding.json")),
            call: existsSync(sourceCallPath) ? read(sourceCallPath) : null,
          }),
          "UPGRADE_AUDIT_INVALID",
          "Migration audit does not match the retained source",
          5,
        );
        // Preserve the complete business graph; only lifecycle metadata and revision may differ.
        const business = (ledger: any) => {
          const { contract_version, runtime_identity, upgrade, revision, updated_at, ...graph } =
            ledger;
          return JSON.stringify(graph);
        };
        requireCondition(
          business(raw) === business(JSON.parse(backupContent)),
          "UPGRADE_STATE_CONFLICT",
          "Business data changed during the registered upgrade",
          5,
        );
        if (state!.phase === "prepared") {
          raw.runtime_identity = target;
          commit("migrated");
        }
        if (state!.phase === "migrated") {
          if (!existsSync(join(store.runPath, "runtime")))
            createDirectoryNoFollow(
              join(store.runPath, "runtime"),
              context.rootPath,
              0o700,
              context.runIdentity,
            );
          if (!sameRunIdentity(bound, target))
            write(
              bindingPath,
              JSON.stringify({
                schema_version: 2,
                run_id: raw.orchestration_id,
                ...target,
                revision: state!.source_binding_revision + 1,
                request_id: state!.operation_id,
                updated_at: new Date().toISOString(),
              }) + "\n",
            );
          commit("binding_switched");
        }
        requireCondition(
          sameRunIdentity(raw.runtime_identity, target) &&
            sameRunIdentity(identityOf(JSON.parse(read(bindingPath))), target),
          "UPGRADE_STATE_CONFLICT",
          "Ledger and binding identities must agree",
          5,
        );
        if (state!.phase === "binding_switched") commit("completed");
        return { changed: true, identity: target, upgrade: state };
      }
    }),
  );
}
