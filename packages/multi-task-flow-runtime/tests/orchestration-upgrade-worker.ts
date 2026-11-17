// Disposable process fixture: never selects default data roots or real native providers.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callerIdentity } from "../lib/orchestration-identity";
import { withRunCommand, withRunLifecycle } from "../lib/orchestration-lifecycle";
import { upgradeOrchestration } from "../lib/orchestration-upgrade";
import { LedgerStore } from "../lib/store";

const input = JSON.parse(await Bun.stdin.text());
const store = new LedgerStore(input.root, input.run_id);
if (input.mode === "stale-read") {
  const Module = input.store_module ? await import(input.store_module) : { LedgerStore };
  const OldStore = Module.LedgerStore;
  const capture = OldStore.prototype.captureBoundary;
  OldStore.prototype.captureBoundary = function () {
    const boundary = capture.call(this);
    writeFileSync(input.ready, "captured");
    return boundary;
  };
  try {
    new OldStore(input.root, input.run_id).read();
    console.log(JSON.stringify({ code: "UNEXPECTED_READ" }));
  } catch (error) {
    console.log(JSON.stringify({ code: error.code, message: error.message }));
  }
} else if (input.mode === "hold") {
  await withRunCommand(store, async () => {
    while (!existsSync(input.release)) await Bun.sleep(10);
  });
} else {
  await withRunLifecycle(store, async () => {
    upgradeOrchestration(store, callerIdentity(), callerIdentity(), {
      afterStage(phase) {
        if (phase === input.kill_after) process.kill(process.pid, "SIGKILL");
      },
    });
  });
}
