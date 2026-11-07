import { LedgerStore } from "../scripts/store";

const ledgerPath = process.argv[2];
if (!ledgerPath) throw new Error("ledger path is required");
const store = new LedgerStore(ledgerPath, "test-run");
for (let i = 0; i < 15; i++) store.update((ledger) => { ledger.revision += 1; });
