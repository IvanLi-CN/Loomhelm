import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanningDemoLedger } from "../examples/orchestration-viewer/ledger";
import { LedgerStore } from "../lib/store";
import { startDashboard } from "../lib/server";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A leased port is required");
const root = mkdtempSync(join(realpathSync(tmpdir()), "orchestration-ui-demo-"));
const ledger = createPlanningDemoLedger();
const store = new LedgerStore(root, ledger.orchestration_id);
store.create(ledger);
cpSync(join(import.meta.dir, "..", "examples", "orchestration-viewer", "requirements"), join(store.runPath, "requirements"), { recursive: true });
const server = await startDashboard({ root, runId: ledger.orchestration_id, port, assetsDir: join(import.meta.dir, "..", "dist"), demoFrame: true });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}/s/${server.token}/`, root }));
async function close() { await server.stop(); rmSync(root, { recursive: true, force: true }); process.exit(0); }
process.once("SIGINT", close); process.once("SIGTERM", close);
