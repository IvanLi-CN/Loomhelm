// Isolated historical storage-primitive coverage, not a public CLI or a version-fence bypass.
import { ZodError, z } from "zod";
import { actorSchema, apply } from "../lib/engine";
import { ContractError } from "../lib/errors";
import { id } from "../lib/schema";
import { LedgerStore } from "../lib/store";
import { migrationCanonicalInput } from "../lib/store-migration";

try {
  const input = JSON.parse(await Bun.stdin.text());
  const store = new LedgerStore(process.env.TASK_ORCHESTRATION_DATA_ROOT!, input.run_id);
  let result: unknown;
  if (Bun.argv[2] === "migrate") {
    const parsed = z
      .object({
        run_id: id,
        actor: actorSchema,
        request_id: id,
        expected_revision: z.number().int().nonnegative(),
        payload: z.object({}).strict(),
      })
      .strict()
      .parse(input);
    result = store.migrate({
      ...parsed,
      canonical_input: migrationCanonicalInput(parsed.run_id, parsed.actor),
    });
  } else result = store.update((ledger) => apply(ledger, Bun.argv[2]!, input));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      code:
        error instanceof ContractError
          ? error.code
          : error instanceof ZodError
            ? "INVALID_INPUT"
            : "IO_ERROR",
      revision: null,
      message: String(error),
      details: {},
    }),
  );
  process.exitCode = error instanceof ContractError ? error.exitCode : 2;
}
