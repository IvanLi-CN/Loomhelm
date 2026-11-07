import { apply, requestSchema } from "./engine";
import {
  effectiveProfile,
  validateProfileCapability,
  type ProfileCapabilities,
} from "./execution-profile";
import { readCodexCapabilities } from "./codex-agent-api";
import { LedgerStore } from "./store";
import {
  executionProfile,
  recommendedExecutionProfile,
  validateLedger,
} from "./schema";
import { requireCondition } from "./errors";

export async function mutateExecutionProfile(
  store: LedgerStore,
  command: string,
  input: unknown,
  getCapabilities: () => Promise<ProfileCapabilities> = readCodexCapabilities,
): Promise<unknown> {
  const parsed = requestSchema.parse(input);
  const snapshot = validateLedger(store.read());
  if (snapshot.requests.some((item) => item.request_id === parsed.request_id)) {
    return store.update((raw) => apply(raw, command, parsed));
  }
  const capabilities = await getCapabilities();
  return store.update((raw) => {
    const ledger = validateLedger(raw);
    requireCondition(
      parsed.run_id === ledger.orchestration_id,
      "RUN_MISMATCH",
      "Request refers to another run",
      3,
    );
    let profile = parsed.payload.execution_profile;
    if (command === "execution-profile-recommend") {
      const target =
        parsed.payload.target_type === "group"
          ? ledger.groups.find((item) => item.id === parsed.payload.target_id)
          : ledger.tasks.find((item) => item.id === parsed.payload.target_id);
      requireCondition(target, "NOT_FOUND", "Profile target not found", 3);
      profile = recommendedExecutionProfile(
        "kind" in target ? target.kind : "other",
        effectiveProfile(ledger, { execution_profile: null }),
      );
    }
    if (profile === null)
      profile = effectiveProfile(ledger, { execution_profile: null });
    validateProfileCapability(executionProfile.parse(profile), capabilities);
    return apply(raw, command, parsed);
  });
}
