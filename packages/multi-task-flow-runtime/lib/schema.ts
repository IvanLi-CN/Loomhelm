import { type Ledger, ledgerSchema } from "./schema-models";
import { normalizeLegacyLedger } from "./schema-normalization";

export * from "./schema-cut";
export * from "./schema-handoff";
export * from "./schema-models";
export * from "./schema-normalization";
export * from "./schema-policies";
export * from "./schema-validation";

/** Parse the durable shape for read-only compatibility views without applying write-time graph rules. */
export function parseLedger(value: unknown): Ledger {
  return ledgerSchema.parse(normalizeLegacyLedger(value));
}
