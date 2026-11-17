import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "../lib/engine";
import type { Ledger } from "../lib/schema";
import { LedgerStore } from "../lib/store";
import { fixtureIdentity } from "./cli-identity-fixture";
export function mockCli(initial: Ledger) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mtf-role-cli-")));
  const store = new LedgerStore(root, initial.orchestration_id);
  initial = {
    ...structuredClone(initial),
    contract_version: fixtureIdentity.ledger_contract,
    runtime_identity: fixtureIdentity,
  };
  store.create(initial);
  let sequence = 0;
  return {
    store,
    calls: () => {
      try {
        return readFileSync(join(root, "calls"), "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    async run(
      command: string,
      payload: Record<string, unknown>,
      options: {
        actor?: Request["actor"];
        requestId?: string;
        revision?: number;
        unknown?: boolean;
      } = {},
    ) {
      const ledger = store.read();
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "mock-codex-cli-worker.ts"),
          command,
          "--input",
          "-",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            TASK_ORCHESTRATION_DATA_ROOT: root,
            MOCK_CODEX_LOG: join(root, "calls"),
            MOCK_CODEX_UNKNOWN: options.unknown ? "1" : "0",
          },
        },
      );
      child.stdin.write(
        JSON.stringify({
          run_id: ledger.orchestration_id,
          actor: options.actor ?? { role: "main", thread_id: ledger.control.owner_thread_id },
          request_id: options.requestId ?? `cli-${++sequence}`,
          expected_revision: options.revision ?? ledger.revision,
          payload,
        }),
      );
      child.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      let output: any;
      try {
        output = JSON.parse(stdout);
      } catch {
        throw new Error(`${stdout}\n${stderr}`);
      }
      return { exit, ...output };
    },
  };
}
