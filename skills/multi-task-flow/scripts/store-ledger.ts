import { ContractError, requireCondition } from "./errors";
import { normalizeLegacyLedger } from "./schema";
import { requireLedgerCompatibility } from "./service-contract";
export function readStoredLedger(read: () => string): any {
  try {
    const raw = JSON.parse(read());
    requireCondition(
      raw?.schema_version === undefined ||
        raw?.schema_version === 1 ||
        raw?.schema_version === 2,
      "UNSUPPORTED_SCHEMA",
      "Ledger schema version is unsupported",
      4,
    );
    // Schema-1 is a legacy read-only shape. Its discriminator was not part of
    // the original contract, so reads remain available until explicit
    // migration even if a stale field is present in the file.
    if (raw?.schema_version !== undefined && raw?.schema_version !== 1)
      requireLedgerCompatibility(raw);
    return normalizeLegacyLedger(raw);
  } catch (error) {
    if (
      error instanceof ContractError &&
      (error.code === "INCOMPATIBLE_LEDGER" ||
        error.code === "UNSUPPORTED_SCHEMA")
    )
      throw error;
    throw new ContractError(
      "LEDGER_UNREADABLE",
      "Ledger is unreadable; explicit recovery is required",
      5,
    );
  }
}
