import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "@loomhelm/runtime-core/modules/core/runtime";
import { z } from "zod";
import { ContractError, requireCondition } from "../lib/errors";
import { maintenanceApply, maintenanceCheck } from "../lib/ledger-maintenance";
import { callerIdentity, runIdentity } from "../lib/orchestration-identity";
import { requireQuiescentRun, withRunLifecycle } from "../lib/orchestration-lifecycle";
import { inspectOrchestration, upgradeOrchestration } from "../lib/orchestration-upgrade";
import { validateLedger } from "../lib/schema";
import { ServiceAuth } from "../lib/service-auth";
import {
  compatibilityReport,
  downgradeApproval,
  selectedRelease,
} from "../lib/service-compatibility";
import { ledgerContract, requireApi } from "../lib/service-contract";
import { agentLease } from "../lib/service-http";
import { importRun } from "../lib/service-import";
import { ensureService, runDaemon, serviceStatus } from "../lib/service-lifecycle";
import {
  assertPackageUpgradeCompatible,
  installPackageRelease,
  installRelease,
  resolvePackageTarget,
  switchRelease,
  upgradePackageRelease,
  upgradePackageReleaseAndStart,
} from "../lib/service-maintenance";
import { servicePaths } from "../lib/service-paths";
import { ServiceState } from "../lib/service-state";
import { cachedDaemonUpdate, triggerDaemonUpdateCheck } from "../lib/service-update";
import { LedgerStore, safeId, withExclusiveLock, writeAtomic } from "../lib/store";
import { buildView } from "../lib/view";

const actor = z
  .object({
    run_id: z.string(),
    thread_id: z.string(),
    api_version: z.number().int(),
  })
  .strict();
const empty = z.object({}).strict();
const source = z.object({ source: z.string().startsWith("/") }).strict();
const packageVersion = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })
  .strict();
const upgradeRequest = z
  .object({ target: z.string().min(1), mode: z.enum(["normal", "dry-run", "rollback"]) })
  .strict();
function verifiedTargetsPath(state: ServiceState): string {
  return join(state.paths.state, "verified-package-targets.json");
}
function verifiedTargets(state: ServiceState): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(verifiedTargetsPath(state), "utf8")) as string[]);
  } catch {
    return new Set();
  }
}
function recordVerifiedTarget(
  state: ServiceState,
  identity: { build_id: string; version: string },
): void {
  withExclusiveLock(join(state.paths.state, "lifecycle.lock"), () => {
    const targets = verifiedTargets(state);
    targets.add(`${identity.version}:${identity.build_id}`);
    writeAtomic(verifiedTargetsPath(state), JSON.stringify([...targets].sort()) + "\n");
  });
}
function requireVerifiedRollback(
  state: ServiceState,
  identity: { build_id: string; version: string },
): void {
  withExclusiveLock(join(state.paths.state, "lifecycle.lock"), () =>
    requireCondition(
      verifiedTargets(state).has(`${identity.version}:${identity.build_id}`),
      "ROLLBACK_TARGET_UNVERIFIED",
      "Rollback target must be verified by an earlier exact dry-run or upgrade",
    ),
  );
}

export async function serviceCommand(
  command: string,
  input: unknown,
  state = new ServiceState(servicePaths()),
): Promise<unknown> {
  if (command === "install") {
    const parsed = z
      .union([
        source.extend({ registry_dir: z.string().startsWith("/").optional() }),
        packageVersion.extend({ registry_dir: z.string().startsWith("/").optional() }),
      ])
      .parse(input);
    if ("version" in parsed)
      return installPackageRelease(state, parsed.version, parsed.registry_dir);
    return installRelease(state, parsed.source, parsed.registry_dir);
  }
  if (command === "gateway-upgrade") {
    const parsed = upgradeRequest.parse(input);
    triggerDaemonUpdateCheck(state);
    const identity = resolvePackageTarget(parsed.target);
    if (parsed.mode === "rollback") requireVerifiedRollback(state, identity);
    if (parsed.mode === "dry-run") {
      assertPackageUpgradeCompatible(state.config(), identity);
      recordVerifiedTarget(state, identity);
      return {
        surface: "gateway",
        changed: false,
        target: identity.version,
        requested: parsed.target,
        dry_run: true,
        handoff: { fixed_port: state.config().port, health_check: true },
      };
    }
    const result = await upgradePackageReleaseAndStart(state, identity.version);
    recordVerifiedTarget(state, identity);
    return result;
  }
  if (command === "orchestration-compatibility-check") {
    const parsed = z.object({ run_id: z.string() }).strict().parse(input);
    return inspectOrchestration(
      new LedgerStore(state.paths.data, safeId(parsed.run_id)),
      callerIdentity(),
    );
  }
  if (command === "orchestration-upgrade") {
    const parsed = z
      .object({
        run_id: z.string(),
        target: z.string().min(1),
        mode: z.enum(["normal", "dry-run", "rollback"]),
      })
      .strict()
      .parse(input);
    requireCondition(
      parsed.mode !== "rollback",
      "DOWNGRADE_FORBIDDEN",
      "Orchestration upgrades are forward-only",
      4,
    );
    const caller = callerIdentity();
    const store = new LedgerStore(state.paths.data, safeId(parsed.run_id));
    return withRunLifecycle(store, async () => {
      const raw = JSON.parse(store.readRaw());
      const pending = raw.upgrade && raw.upgrade.phase !== "completed" ? raw.upgrade : null;
      // A registered attempt never re-resolves mutable tags, even on explicit resume.
      const self = parsed.target === caller.package_version;
      const identity = pending || self ? null : resolvePackageTarget(parsed.target);
      const target = pending
        ? runIdentity.parse(pending.target)
        : self
          ? caller
          : runIdentity.parse({
              package_name: identity!.package_name,
              package_version: identity!.version,
              build_id: identity!.build_id,
              source_sha: identity!.source_sha,
              compatibility_line: identity!.compatibility_line,
              ledger_contract: identity!.contracts.ledger,
              api_contract: identity!.contracts.api,
              frontend_contract: identity!.contracts.frontend,
              viewer_contract: identity!.contracts.viewer,
            });
      if (pending)
        requireCondition(
          [pending.requested_selector, target.package_version].includes(parsed.target),
          "UPGRADE_TARGET_FROZEN",
          "Resume the registered target",
          4,
        );
      return upgradeOrchestration(
        store,
        caller,
        target,
        {
          withQuiescentRun: (ledger, action) => requireQuiescentRun(store, ledger, action),
        },
        parsed.mode === "dry-run",
        parsed.target,
      );
    });
  }
  if (command === "compatibility-check") {
    const parsed = z.union([source, z.object({ rollback: z.literal(true) }).strict()]).parse(input);
    return compatibilityReport(
      state,
      selectedRelease(state, parsed),
      "source" in parsed ? parsed.source : undefined,
    );
  }
  if (command === "ledger-maintenance-check") return maintenanceCheck(state, input);
  if (command === "ledger-maintenance-apply") return maintenanceApply(state, input);
  if (command === "upgrade") {
    const parsed = z
      .union([
        source.extend({ write_downgrade_approval: downgradeApproval.optional() }),
        packageVersion.extend({ write_downgrade_approval: downgradeApproval.optional() }),
      ])
      .parse(input);
    if ("version" in parsed) return upgradePackageRelease(state, parsed.version);
    return switchRelease(state, parsed.source, false, undefined, parsed.write_downgrade_approval);
  }
  if (command === "rollback") {
    const parsed = z
      .object({ write_downgrade_approval: downgradeApproval.optional() })
      .strict()
      .parse(input);
    if (existsSync(join(state.paths.config, "service.json")) && state.config().package_name)
      throw new ContractError(
        "PACKAGE_ROLLBACK_UNSUPPORTED",
        "Package-backed daemon rollback requires an explicit exact package upgrade",
      );
    return switchRelease(state, "", true, undefined, parsed.write_downgrade_approval);
  }
  if (command === "import" || command === "migrate") {
    const parsed = z
      .object({ source_root: z.string().startsWith("/"), run_id: z.string() })
      .strict()
      .parse(input);
    return importRun(state, parsed.source_root, parsed.run_id);
  }
  if (command === "ensure") {
    const result = await ensureService(state, actor.parse(input));
    triggerDaemonUpdateCheck(state);
    const daemonUpdate = cachedDaemonUpdate(state);
    return daemonUpdate ? { ...result, daemon_update: daemonUpdate } : result;
  }
  if (command === "renew" || command === "release") {
    const parsed = actor.parse(input);
    requireApi(parsed.api_version);
    requireCondition(
      existsSync(join(state.paths.config, "service.json")),
      "SERVICE_NOT_INSTALLED",
      "Viewer is not installed",
    );
    const lease = agentLease({ ...parsed, api_version: 1 });
    if (command === "renew") {
      await serviceStatus(state);
      return state.renew(lease, state.config().agent_ttl_ms);
    }
    state.release(lease.id);
    return { released: lease.id };
  }
  if (command === "status" || command === "doctor") {
    empty.parse(input);
    if (!existsSync(join(state.paths.config, "service.json")))
      return { installed: false, running: false, root: state.paths.root };
    try {
      triggerDaemonUpdateCheck(state);
      return {
        installed: true,
        running: true,
        ...(await serviceStatus(state)),
        leases: state.runtime().leases,
        ...(cachedDaemonUpdate(state) ? { daemon_update: cachedDaemonUpdate(state) } : {}),
      };
    } catch {
      return {
        installed: true,
        running: false,
        root: state.paths.root,
        configured_build: state.config().current_build,
        runtime: state.runtime(),
        action:
          "Use ensure; if startup fails inspect launchctl print for the configured user service",
      };
    }
  }
  if (command === "login") {
    const parsed = z.object({ run_id: z.string().optional() }).strict().parse(input);
    await serviceStatus(state);
    const daemonUpdate = cachedDaemonUpdate(state);
    const target = parsed.run_id ? `/runs/${parsed.run_id}/` : "/";
    const ticket = new ServiceAuth(state).ticket(target);
    const loginUrl = new URL(target, `http://127.0.0.1:${state.config().port}`);
    loginUrl.searchParams.set("ticket", ticket);
    return {
      login_url: loginUrl.toString(),
      expires_in_seconds: 60,
      single_use: true,
      ...(daemonUpdate ? { daemon_update: daemonUpdate } : {}),
    };
  }
  if (command === "credential-rotate" || command === "credential-revoke") {
    empty.parse(input);
    state.config();
    new ServiceAuth(state).rotate();
    state.transaction((runtime) => {
      runtime.leases = runtime.leases.filter((lease) => lease.kind !== "browser");
    });
    return { sessions_revoked: true };
  }
  if (command === "reader-check") {
    const parsed = z.object({ ledger: z.unknown() }).strict().parse(input);
    const ledger = validateLedger(parsed.ledger);
    return { contract: ledgerContract(ledger), revision: ledger.revision };
  }
  if (command === "read-only-view") {
    const parsed = z
      .object({ ledger: z.unknown(), plan_id: z.string().optional() })
      .strict()
      .parse(input);
    const ledger = validateLedger(parsed.ledger);
    return { view: buildView(ledger, parsed.plan_id) };
  }
  throw new ContractError("INVALID_COMMAND", "Unknown viewer service command");
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    if (command === "daemon") {
      requireCondition(
        process.argv.length === 3,
        "INVALID_ARGUMENTS",
        "Daemon accepts no input arguments",
      );
      await runDaemon(new ServiceState(servicePaths()));
    } else {
      requireCondition(
        command &&
          process.argv.length === 5 &&
          process.argv[3] === "--input" &&
          process.argv[4] === "-",
        "INVALID_ARGUMENTS",
        "Usage: service.ts <command> --input -",
      );
      const text = await Runtime.stdin.text();
      const inputLimit =
        command === "reader-check" || command === "read-only-view" ? 256 * 1024 * 1024 : 16_384;
      requireCondition(
        text.length <= inputLimit,
        "INPUT_TOO_LARGE",
        "Service command input is too large",
      );
      const result = await serviceCommand(command, JSON.parse(text));
      console.log(JSON.stringify({ ok: true, code: "OK", result }));
    }
  } catch (error) {
    if (process.argv[2] === "daemon") {
      try {
        const state = new ServiceState(servicePaths());
        state.initialize();
        writeFileSync(
          join(state.paths.state, "startup-failure.json"),
          JSON.stringify({
            at: new Date().toISOString(),
            category: error instanceof Error ? error.name : "Unknown",
            code:
              error instanceof ContractError
                ? error.code
                : ((error as NodeJS.ErrnoException)?.code ?? "SERVICE_ERROR"),
          }),
          { mode: 0o600 },
        );
      } catch {}
    }
    const code =
      error instanceof ContractError
        ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? "INVALID_INPUT"
          : "SERVICE_ERROR";
    console.error(
      JSON.stringify({
        ok: false,
        code,
        ...(error instanceof ContractError && error.details !== undefined
          ? { details: error.details }
          : {}),
        message:
          error instanceof ContractError
            ? error.message
            : "Service operation failed; inspect isolated state and maintenance journal",
      }),
    );
    process.exitCode = error instanceof ContractError ? error.exitCode : 1;
  }
}
