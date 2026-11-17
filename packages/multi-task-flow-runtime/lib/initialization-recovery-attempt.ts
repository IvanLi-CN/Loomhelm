import { createHash } from "node:crypto";
import { z } from "zod";
import { recoveryPermissions } from "./recovery-permissions";
import { executionProfile, id } from "./schema";

export const recoveryAttempt = z
  .object({
    attempt_id: id,
    native_request_id: id,
    thread_id: id,
    original_turn_id: id,
    original_items_digest: z.string().regex(/^[a-f0-9]{64}$/),
    prompt_version: z.literal(1),
    prompt_digest: z.string().regex(/^[a-f0-9]{64}$/),
    workspace_path: z.string().min(1),
    initial_head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    execution_profile: executionProfile,
    recovery_turn_id: id.optional(),
    permissions: z
      .object({ version: z.literal(1), original: recoveryPermissions.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type RecoveryAttempt = z.infer<typeof recoveryAttempt>;
export function recoveryDigest(value: unknown): string {
  const canonical = (input: any): any =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
