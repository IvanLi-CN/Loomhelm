import { executionProfile, type Ledger } from "../lib/schema";
import { requireCondition } from "../lib/errors";

export function migrateProfile(ledger: Ledger, profile: unknown): void {
  requireCondition(
    !ledger.config.execution_profile,
    "PROFILE_ALREADY_MIGRATED",
    "Run already has a default profile",
    3,
  );
  ledger.config.execution_profile = executionProfile.parse(profile);
}
