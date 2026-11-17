import { expect, test } from "bun:test";
import { withRecoveryWriter } from "../lib/codex-recovery-writer";
import { type RecoveryAttempt, recoveryAttempt } from "../lib/initialization-recovery-attempt";
import {
  readPermissions,
  restrictedPermissions,
  samePermissions,
} from "../lib/recovery-permissions";

test("native permissions preserve roots, flags and granular approval policy losslessly", () => {
  const response = {
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/owned"],
      networkAccess: true,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
    approvalPolicy: {
      granular: {
        rules: true,
        sandbox_approval: false,
        mcp_elicitations: false,
        request_permissions: false,
        skill_approval: false,
      },
    },
    approvalsReviewer: "auto_review",
    activePermissionProfile: null,
  };
  const original = readPermissions(response);
  expect(original.sandboxPolicy).toEqual(response.sandbox);
  expect(original.approvalPolicy).toEqual(response.approvalPolicy);
  expect(samePermissions(original, structuredClone(original))).toBe(true);
  expect(restrictedPermissions(original)).toEqual({
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
  });
  for (const activePermissionProfile of [undefined, { id: "managed" }])
    expect(() => readPermissions({ ...response, activePermissionProfile })).toThrow("profile");
  expect(() => readPermissions({ ...response, sandbox: { type: "unknown" } })).toThrow();
});

test("historical attempts remain readable but cannot enter a mutating writer without a snapshot contract", async () => {
  const historical = recoveryAttempt.parse({
    attempt_id: "old",
    native_request_id: "native",
    thread_id: "thread",
    original_turn_id: "turn",
    original_items_digest: "a".repeat(64),
    prompt_version: 1,
    prompt_digest: "b".repeat(64),
    workspace_path: "/owned",
    initial_head: "c".repeat(40),
    execution_profile: { model: "test", thinking: "medium" },
  });
  let called = false;
  await expect(
    withRecoveryWriter(
      historical as RecoveryAttempt,
      async () => {
        called = true;
      },
      {
        restrict: false,
        capture: () => {
          called = true;
        },
      },
    ),
  ).rejects.toThrow("historical attempt requires independent audit");
  expect(called).toBe(false);
});
