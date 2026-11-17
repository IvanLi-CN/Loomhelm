import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { withExclusiveLockAsync } from "@loomhelm/runtime-core/modules/flow/storage";
import {
  readRegularNoFollow,
  writeExclusiveNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { ContractError, requireCondition } from "./errors";
import { executeInvocation, inspectInvocation } from "./invocation-journal";
import { migrationDigest } from "./migration-audit";
import { callerIdentity, requireRunBinding } from "./orchestration-identity";
import { validateLedger } from "./schema";
import type { LedgerStore } from "./store";

/** A waiter on a retired directory must retry instead of running under its obsolete lock. */
export async function withRunLifecycle<T>(
  store: LedgerStore,
  action: () => Promise<T>,
  acquire: typeof withExclusiveLockAsync = withExclusiveLockAsync,
): Promise<T> {
  // Publish the lock file under the already-established maintenance/ledger
  // exclusion. Concurrent native openers must never observe its create/chmod window.
  store.maintain((context) => {
    const path = join(store.runPath, "locks", "lifecycle.lock");
    if (!existsSync(path)) writeExclusiveNoFollow(path, "", context.rootPath);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const before = lstatSync(store.runPath);
    requireCondition(
      before.isDirectory() && !before.isSymbolicLink(),
      "UNSAFE_PATH",
      "Run directory must be a private directory",
      5,
    );
    let actionStarted = false;
    try {
      const outcome = await acquire(
        join(store.runPath, "locks", "lifecycle.lock"),
        async () => {
          const current = lstatSync(store.runPath);
          if (before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink())
            return { changed: true as const };
          actionStarted = true;
          return { changed: false as const, value: await action() };
        },
        Math.max(1, deadline - Date.now()),
      );
      // A changed boundary has executed no action and may safely reacquire the current lock.
      if (!outcome.changed) return outcome.value;
    } catch (error) {
      const current = lstatSync(store.runPath);
      // The native opener may detect the exchange before our callback runs.
      // Reacquire only a changed boundary, never replay an action or hide an unrelated error.
      if (
        actionStarted ||
        !(error instanceof Error) ||
        ![
          "secure_lock_parent_rejected",
          "secure_lock_file_changed",
          "secure_lock_open_failed",
        ].includes(error.message) ||
        (before.dev === current.dev && before.ino === current.ino)
      )
        throw error;
    }
  }
  throw new ContractError(
    "RUN_BOUNDARY_CHANGED",
    "Run directory kept changing while waiting; retry against its current binding",
    4,
  );
}

/** The marker survives a killed parent: PID disappearance alone never proves native-call completion. */
const executing = new AsyncLocalStorage<string>();

export async function withRunCommand<T>(
  store: LedgerStore,
  action: () => Promise<T>,
  command = "unknown",
  input: unknown = {},
): Promise<T> {
  if (executing.getStore() === store.runPath) return action();
  return withRunLifecycle(store, async () => {
    const ledger = validateLedger(store.read());
    const identity = callerIdentity();
    requireRunBinding(store.rootPath, ledger.orchestration_id, ledger, identity);
    const path = join(store.runPath, "runtime", "call.json");
    if (existsSync(path)) {
      const content = readRegularNoFollow(path, store.rootPath).toString("utf8");
      // The immutable source snapshot retains this receipt. Retiring it does not
      // assert termination: every unresolved business attempt remains unchanged.
      const carried =
        ledger.contract_version === 5 &&
        ledger.upgrade?.phase === "completed" &&
        ledger.upgrade.migration_audit?.source_call_digest === migrationDigest(content);
      const previous = carried ? null : JSON.parse(content);
      requireCondition(
        carried || (previous.state === "stopped" && inspectInvocation(store)?.quiescent === true),
        "RUN_QUIESCENCE_UNPROVEN",
        "An earlier invocation has no safe-stop receipt; inspect its native calls",
        4,
      );
    }
    return executeInvocation(store, command, input, () => executing.run(store.runPath, action));
  });
}
