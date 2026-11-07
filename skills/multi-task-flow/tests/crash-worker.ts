import { LedgerStore } from "../scripts/store";

const requestedStage = process.argv[3];
const ledgerPath = process.argv[2];
if (!ledgerPath) throw new Error("ledger path is required");
const store = new LedgerStore(ledgerPath, "test-run", (stage) => {
  if (stage === requestedStage) process.kill(process.pid, "SIGKILL");
});
store.update((ledger) => { ledger.revision = 1; });
