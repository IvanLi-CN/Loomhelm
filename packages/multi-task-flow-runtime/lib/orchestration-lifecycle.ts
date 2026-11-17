import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { withExclusiveLockAsync } from "@loomhelm/runtime-core/modules/flow/storage";
import {
  readRegularNoFollow,
  writeAtomicNoFollow,
} from "@loomhelm/runtime-core/modules/visual/secure_io";
import { ContractError, requireCondition } from "./errors";
import { callerIdentity, requireRunBinding } from "./orchestration-identity";
import type { LedgerStore } from "./store";

/** A waiter on a retired directory must retry instead of running under its obsolete lock. */
export async function withRunLifecycle<T>(
  store: LedgerStore,
  action: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const before = lstatSync(store.runPath);
    requireCondition(
      before.isDirectory() && !before.isSymbolicLink(),
      "UNSAFE_PATH",
      "Run directory must be a private directory",
      5,
    );
    const outcome = await withExclusiveLockAsync(
      join(store.runPath, "locks", "lifecycle.lock"),
      async () => {
        const current = lstatSync(store.runPath);
        if (before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink())
          return { changed: true as const };
        return { changed: false as const, value: await action() };
      },
      Math.max(1, deadline - Date.now()),
    );
    // A changed boundary has executed no action and may safely reacquire the current lock.
    if (!outcome.changed) return outcome.value;
  }
  throw new ContractError(
    "RUN_BOUNDARY_CHANGED",
    "Run directory kept changing while waiting; retry against its current binding",
    4,
  );
}

/** The marker survives a killed parent: PID disappearance alone never proves native-call completion. */
const executing = new AsyncLocalStorage<string>();

export async function withRunCommand<T>(store: LedgerStore, action: () => Promise<T>): Promise<T> {
  if (executing.getStore() === store.runPath) return action();
  return withRunLifecycle(store, async () => {
    const ledger = store.read();
    const identity = callerIdentity();
    requireRunBinding(store.rootPath, ledger.orchestration_id, ledger, identity);
    const path = join(store.runPath, "runtime", "call.json");
    if (existsSync(path)) {
      const previous = JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8"));
      requireCondition(
        previous.state === "stopped",
        "RUN_QUIESCENCE_UNPROVEN",
        "An earlier invocation has no safe-stop receipt; inspect its native calls",
        4,
      );
    }
    const receipt = { invocation_id: randomUUID(), identity, state: "running" };
    writeAtomicNoFollow(path, JSON.stringify(receipt), store.rootPath);
    try {
      return await executing.run(store.runPath, action);
    } finally {
      // Action implementations must join their child processes and close native transports before returning.
      writeAtomicNoFollow(path, JSON.stringify({ ...receipt, state: "stopped" }), store.rootPath);
    }
  });
}
export function requireQuiescentRun<T>(store: LedgerStore, ledger: any, action: () => T): T {
  const path = join(store.runPath, "runtime", "call.json");
  const receipt = existsSync(path)
    ? JSON.parse(readRegularNoFollow(path, store.rootPath).toString("utf8"))
    : null;
  requireCondition(
    !receipt || receipt.state === "stopped",
    "RUN_QUIESCENCE_UNPROVEN",
    "A registered invocation has no safe-stop receipt; no process will be killed",
    4,
  );
  // Old releases did not register native invocation lifetimes. Preserve uncertainty, never infer a stop from status or PID.
  const ambiguous =
    ledger.operations.some((operation: any) => ["claimed", "unknown"].includes(operation.status)) ||
    ledger.notifications.some((notification: any) => notification.delivery_status === "unknown") ||
    ledger.resources.some((resource: any) =>
      ["archive_unknown", "unarchive_unknown"].includes(resource.status),
    );
  requireCondition(
    !ambiguous || Boolean(receipt),
    "RUN_QUIESCENCE_UNPROVEN",
    "Historical pending operations have no verified native-call stop receipt",
    4,
  );
  return action();
}
