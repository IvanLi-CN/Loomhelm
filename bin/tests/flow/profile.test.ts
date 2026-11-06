import { expect, test } from "bun:test";
import {
  readFile,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes, stableHash } from "../../modules/flow/common";
import {
  eventToolUseId,
  parseModelDirective,
  preToolUse,
  profileOverrideUnavailable,
  runHook,
  userPromptSubmit,
} from "../../modules/flow/profile-hook";
import {
  loadPermit,
  permitKey,
  stateDir,
  updatePermitState,
} from "../../modules/flow/profile-state";
import { attestNativeProfile } from "../../modules/flow/profile-attest";
import { findParentRollout } from "../../modules/flow/profile-attest-discovery";
import { stableTranscriptBytes } from "../../modules/flow/profile-transcript";

async function withTemp<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "profile-flow-")));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("default profile state directory uses a canonical temporary parent", async () => {
  expect(stateDir({})).toBe(
    join(await realpath(tmpdir()), "codex-agent-profile-runtime"),
  );
});

test("profile directives persist as compact canonical state and gate launches", async () => {
  await withTemp(async (root) => {
    expect(
      parseModelDirective("\nagent-model: gpt-6-luna\nUse the override"),
    ).toBe("gpt-6-luna");
    expect(parseModelDirective("agent-model: auto")).toBeNull();
    expect(() =>
      parseModelDirective("agent-model: gpt-6-luna\nagent-model: auto"),
    ).toThrow("duplicate");
    expect(
      userPromptSubmit(
        { prompt: "agent-model: gpt-6-luna", session_id: "session-1" },
        root,
      ),
    ).toEqual({ continue: true });
    expect(await readFile(join(root, "model_overrides.json"), "utf8")).toBe(
      '{"sessions":{"session-1":{"model":"gpt-6-luna"}},"version":1}\n',
    );
    expect(
      preToolUse(
        {
          tool_name: "Agent",
          session_id: "session-1",
          tool_input: { model: "gpt-6-luna", reasoning_effort: "medium" },
        },
        root,
      ),
    ).toEqual({ continue: true });
    expect(
      preToolUse(
        {
          tool_name: "Agent",
          session_id: "session-1",
          tool_input: { model: "gpt-6.1-sol", reasoning_effort: "high" },
        },
        root,
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(
      preToolUse(
        {
          tool_name: "Agent",
          session_id: "session-terra",
          tool_input: { model: "gpt-6.1-terra", reasoning_effort: "xhigh" },
        },
        root,
      ),
    ).toEqual({ continue: true });
    expect(
      preToolUse(
        {
          tool_name: "send_message_to_thread",
          session_id: "session-1",
          tool_input: { model: "gpt-6-luna" },
        },
        root,
      ),
    ).toEqual({ continue: true });
  });
});

test("profile fallback blockers and event identity parsing fail closed", () => {
  expect(
    profileOverrideUnavailable(
      { error: "model gpt-6-luna with effort medium is unavailable" },
      "gpt-6-luna",
      "medium",
    ),
  ).toBe(true);
  expect(
    profileOverrideUnavailable(
      { error: "model gpt-6-luna with effort medium is unavailable; retry" },
      "gpt-6-luna",
      "medium",
    ),
  ).toBe(false);
  expect(eventToolUseId({ call_id: "call-1" })).toBe("call-1");
  expect(eventToolUseId({})).toBeUndefined();
});

test("fallback permits are keyed by the canonical logical identity", async () => {
  await withTemp(async (root) => {
    const identity = {
      session_id: "parent",
      task_name: "flow",
      agent_type: "review",
      fork_turns: "1",
      message_digest: stableHash("review"),
    };
    const permit = {
      identity,
      failed_requested: { model: "gpt-6-luna", effort: "medium" },
      failure_tool_use_id: "failed-call",
      failure_evidence_sha256: "c".repeat(64),
      status: "consumed",
      consumed_tool_use_id: "started-call",
      fallback_requested: { model: "gpt-6.1-sol", effort: "high" },
    };
    updatePermitState(root, (state) => {
      state.permits[permitKey(identity)] = permit;
    });
    expect(loadPermit(root, identity)).toEqual(permit);
    expect(permitKey(identity)).toBe(stableHash(identity));
  });
});

test("hook state can be redirected without changing the process environment", async () => {
  await withTemp(async (root) => {
    expect(
      runHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "agent-model: gpt-6-luna",
          session_id: "hook-session",
        },
        root,
      ),
    ).toEqual({ continue: true });
    expect(
      await readFile(join(root, "model_overrides.json"), "utf8"),
    ).toContain("hook-session");
  });
});

test("native transcript reads reject symlinked files", async () => {
  await withTemp(async (root) => {
    const outside = join(tmpdir(), `profile-transcript-${Date.now()}.jsonl`);
    const linked = join(root, "child.jsonl");
    await writeFile(
      outside,
      '{"type":"session_meta","payload":{"id":"outside"}}\n',
    );
    await symlink(outside, linked);
    expect(() => stableTranscriptBytes(linked)).toThrow();
    await rm(outside, { force: true });
  });
});

test("native attestation derives a direct profile resolution", async () => {
  await withTemp(async (root) => {
    const parent = [
      { type: "session_meta", payload: { id: "parent-1" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-started",
          arguments: JSON.stringify({
            task_name: "flow-review",
            agent_type: "reviewer",
            fork_turns: "none",
            message: "Review the current candidate.",
            model: "gpt-5.6-luna",
            reasoning_effort: "medium",
          }),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-started",
          agent_thread_id: "child-1",
        },
      },
    ];
    const child = [
      {
        type: "session_meta",
        payload: {
          id: "child-1",
          parent_thread_id: "parent-1",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_path: "/root/flow-review",
                agent_role: "reviewer",
              },
            },
          },
        },
      },
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "Review complete.",
        },
      },
    ];
    await writeFile(
      join(root, "parent-1.jsonl"),
      `${parent.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(
      join(root, "child-1.jsonl"),
      `${child.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const resolution = attestNativeProfile({
      sessionsRoot: root,
      taskName: "flow-review",
      agentType: "reviewer",
      preferredModel: "gpt-5.6-luna",
      preferredEffort: "medium",
    });
    expect(resolution).toMatchObject({
      fallback_reason: null,
      resolved: {
        model: "gpt-5.6-luna",
        effort: "medium",
        child_thread_id: "child-1",
        turn_id: "turn-1",
      },
    });
  });
});

test("native attestation enforces review constraints", async () => {
  await withTemp(async (root) => {
    const candidateHead = "a".repeat(40);
    const resultMessage = "Review complete.";
    const expectedResult = sha256Bytes(new TextEncoder().encode(resultMessage));
    const parent = [
      { type: "session_meta", payload: { id: "parent-1" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-started",
          arguments: JSON.stringify({
            task_name: "flow-review",
            agent_type: "reviewer",
            fork_turns: "none",
            message: "Review the current candidate.",
            model: "gpt-5.6-luna",
            reasoning_effort: "medium",
          }),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-started",
          agent_thread_id: "child-1",
        },
      },
    ];
    const child = [
      {
        type: "session_meta",
        payload: {
          id: "child-1",
          parent_thread_id: "parent-1",
          git: { commit_hash: candidateHead },
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_path: "/root/flow-review",
                agent_role: "reviewer",
              },
            },
          },
        },
      },
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: resultMessage,
        },
      },
    ];
    await writeFile(
      join(root, "parent-1.jsonl"),
      `${parent.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(
      join(root, "child-1.jsonl"),
      `${child.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const options = {
      sessionsRoot: root,
      taskName: "flow-review",
      agentType: "reviewer",
      preferredModel: "gpt-5.6-luna",
      preferredEffort: "medium",
    };
    expect(
      attestNativeProfile({
        ...options,
        expectedChildThreadId: "child-1",
        expectedRepositoryHead: candidateHead,
        expectedResultSha256: expectedResult,
        requiredForkTurns: "none",
      }),
    ).toMatchObject({
      fallback_reason: null,
      resolved: { child_thread_id: "child-1", turn_id: "turn-1" },
    });
    expect(() =>
      attestNativeProfile({
        ...options,
        expectedRepositoryHead: "b".repeat(40),
      }),
    ).toThrow("expected candidate head");
    expect(() =>
      attestNativeProfile({
        ...options,
        expectedResultSha256: sha256Bytes(new TextEncoder().encode("wrong")),
      }),
    ).toThrow("unique final child completion");
    expect(() =>
      attestNativeProfile({ ...options, requiredForkTurns: "all" }),
    ).toThrow("requires fork_turns=all");
  });
});

test("native attestation rejects replayed parent and stale child result", async () => {
  await withTemp(async (root) => {
    const parent = [
      { type: "session_meta", payload: { id: "parent-1" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-started",
          arguments: JSON.stringify({
            task_name: "flow-review",
            agent_type: "reviewer",
            fork_turns: "none",
            message: "Review the current candidate.",
            model: "gpt-5.6-luna",
            reasoning_effort: "medium",
          }),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "call-started",
          agent_thread_id: "child-1",
        },
      },
      {
        type: "turn_context",
        payload: {
          turn_id: "parent-turn-1",
          model: "gpt-5.6-terra",
          effort: "high",
        },
      },
    ];
    const firstResult = "first-child-result";
    const child = [
      {
        type: "session_meta",
        payload: {
          id: "child-1",
          parent_thread_id: "parent-1",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_path: "/root/flow-review",
                agent_role: "reviewer",
              },
            },
          },
        },
      },
      parent[2],
      parent[3],
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: firstResult,
        },
      },
    ];
    await writeFile(
      join(root, "parent-1.jsonl"),
      `${parent.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    await writeFile(
      join(root, "child-1.jsonl"),
      `${child.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const options = {
      sessionsRoot: root,
      taskName: "flow-review",
      agentType: "reviewer",
      preferredModel: "gpt-5.6-luna",
      preferredEffort: "medium",
      expectedResultSha256: sha256Bytes(new TextEncoder().encode(firstResult)),
    };
    expect(attestNativeProfile(options)).toMatchObject({
      resolved: { child_thread_id: "child-1", turn_id: "turn-1" },
    });
    child.push(
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-2",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-2",
          last_agent_message: "second-child-result",
        },
      },
    );
    await writeFile(
      join(root, "child-1.jsonl"),
      `${child.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    expect(() => attestNativeProfile(options)).toThrow(
      "unique final child completion",
    );
  });
});

test("native attestation rejects duplicate parent rollouts", async () => {
  await withTemp(async (root) => {
    const metadata = JSON.stringify({
      type: "session_meta",
      payload: { id: "parent-1" },
    });
    await writeFile(join(root, "parent-1-first.jsonl"), `${metadata}\n`);
    await writeFile(join(root, "parent-1-second.jsonl"), `${metadata}\n`);
    expect(() => findParentRollout(root, "parent-1")).toThrow(
      "exactly one parent rollout",
    );
  });
});
