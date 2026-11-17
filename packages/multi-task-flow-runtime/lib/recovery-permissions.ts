import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { record } from "./codex-rpc";

// Preserve the native wire values, including workspace roots and granular approval flags.
export const recoveryPermissions = z
  .object({
    sandboxPolicy: z
      .record(z.string(), z.unknown())
      .refine((value) =>
        ["readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox"].includes(
          String(value.type),
        ),
      ),
    approvalPolicy: z.union([
      z.enum(["never", "on-request", "untrusted"]),
      z.object({ granular: z.record(z.string(), z.boolean()) }).strict(),
    ]),
    approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
  })
  .strict();
export type RecoveryPermissions = z.infer<typeof recoveryPermissions>;

export function readPermissions(response: Record<string, unknown>): RecoveryPermissions {
  // Named profiles cannot be reconstructed from a legacy sandbox policy without losing identity.
  if (response.activePermissionProfile !== null)
    throw new Error("Recovery cannot preserve a named or unavailable native permissions profile");
  return recoveryPermissions.parse({
    sandboxPolicy: record(response.sandbox),
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
  });
}
export function samePermissions(left: RecoveryPermissions, right: RecoveryPermissions): boolean {
  return isDeepStrictEqual(left, right);
}
export function restrictedPermissions(original: RecoveryPermissions): RecoveryPermissions {
  return {
    ...original,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "never",
  };
}
