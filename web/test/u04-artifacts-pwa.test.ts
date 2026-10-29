import { describe, expect, test } from "bun:test";

import {
  classifyConversationEvent,
  inspectableRawPayload
} from "../src/features/artifacts/content";
import { artifactMetadataRequestKey } from "../src/features/artifacts/useArtifactMetadata";
import {
  initialPwaUpdateState,
  reducePwaUpdateState
} from "../src/features/pwa/usePwaRuntime";

describe("U04 conversation content classification", () => {
  test("reads agent message deltas from the persisted JSON-RPC envelope", () => {
    const payload = {
      method: "item/agentMessage/delta",
      params: { delta: "来自持久化 Codex envelope" }
    } as const;
    const content = classifyConversationEvent({ event_id: "message-1", type: "message.delta", payload });

    expect(content).toMatchObject({ kind: "message", role: "assistant", text: "来自持久化 Codex envelope" });
    expect(content.raw).toEqual(payload);
  });

  test("reads native message content arrays from the persisted item envelope", () => {
    const payload = {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]
        }
      }
    } as const;
    const content = classifyConversationEvent({ event_id: "message-content-1", type: "item.completed", payload });

    expect(content).toMatchObject({ kind: "message", role: "assistant", text: "第一段第二段" });
    expect(content.raw).toEqual(payload);
  });

  test("preserves the user role for native user message items", () => {
    const content = classifyConversationEvent({
      event_id: "user-message-1",
      type: "item.completed",
      payload: { params: { item: { type: "userMessage", content: [{ type: "text", text: "用户输入" }] } } }
    });

    expect(content).toMatchObject({ kind: "message", role: "user", text: "用户输入" });
  });

  test("reads nested tool items and command output without misclassifying them as messages", () => {
    const tool = classifyConversationEvent({
      event_id: "tool-1",
      type: "item.started",
      payload: {
        method: "item/started",
        params: { item: { type: "mcpToolCall", tool: "read_summary", status: "inProgress" } }
      }
    });
    const output = classifyConversationEvent({
      event_id: "tool-output-1",
      type: "message.delta",
      payload: { method: "item/commandExecution/outputDelta", params: { delta: "stdout line" } }
    });

    expect(tool).toMatchObject({ kind: "tool", name: "read_summary", status: "running" });
    expect(output).toMatchObject({ kind: "tool", status: "running", summary: "stdout line" });
  });

  test("keeps the legacy flat payload shape classifiable", () => {
    const content = classifyConversationEvent({
      event_id: "legacy-tool-1",
      type: "item.completed",
      payload: { type: "mcpToolCall", tool: "read_summary", status: "completed" }
    });

    expect(content).toMatchObject({ kind: "tool", name: "read_summary", status: "completed" });
  });

  test("keeps raw events lossless while protecting the inspection projection", () => {
    const raw = {
      method: "item/futureRenderer/v9",
      params: {
        token: "secret-token",
        item: { type: "futureContent", cwd: "/Users/ivan/private-workspace", xFutureField: { keep: true } }
      }
    } as const;
    const content = classifyConversationEvent({ event_id: "future-1", type: "unknown", payload: raw });

    expect(content.raw).toEqual(raw);
    expect(inspectableRawPayload(content.raw)).toEqual({
      method: "item/futureRenderer/v9",
      params: {
        token: "[已隐藏]",
        item: { type: "futureContent", cwd: "[路径已隐藏]", xFutureField: { keep: true } }
      }
    });
  });

  test("redacts inline secrets and private paths in unknown string fields", () => {
    expect(inspectableRawPayload({
      detail: "Authorization: Bearer secret-token cwd=/workspace/private-project"
    })).toEqual({ detail: "Authorization: [已隐藏] cwd=[路径已隐藏]" });
    expect(inspectableRawPayload({
      detail: "output path /Users/name/Library/Application Support/loomhelm/file.txt"
    })).toEqual({ detail: "output path [路径已隐藏]" });
    expect(inspectableRawPayload({ detail: "tool output /opt/build/cache" })).toEqual({ detail: "tool output /opt/build/cache" });
  });

  test("protects absolute code filenames without changing the raw event", () => {
    const raw = { type: "code", path: "/Users/name/private/example.go", code: "package example" } as const;
    const content = classifyConversationEvent({ event_id: "code-private-path-1", type: "item.completed", payload: raw });

    expect(content).toMatchObject({ kind: "code", filename: "[路径已隐藏]", code: "package example" });
    expect(content.raw).toEqual(raw);
  });
});

describe("U04 artifact and PWA state identities", () => {
  test("changes the metadata request identity when the authorized loader changes", () => {
    expect(artifactMetadataRequestKey("artifact-1", 0, "principal-a")).not.toBe(artifactMetadataRequestKey("artifact-1", 0, "principal-b"));
    expect(artifactMetadataRequestKey("artifact-1", 1, "principal-a")).not.toBe(artifactMetadataRequestKey("artifact-1", 0, "principal-a"));
  });

  test("does not call an update applied until the service worker reports activation", () => {
    const available = reducePwaUpdateState(initialPwaUpdateState, { type: "available" });
    const requested = reducePwaUpdateState(available, { type: "request" });

    expect(requested).toEqual({ available: true, applied: false, updating: true, error: false });
    expect(reducePwaUpdateState(requested, { type: "activated" })).toEqual({ available: false, applied: true, updating: false, error: false });
  });

  test("keeps a failed update retryable without hiding the available update", () => {
    const failed = reducePwaUpdateState({ available: true, applied: false, updating: true, error: false }, { type: "failed" });

    expect(failed).toEqual({ available: true, applied: false, updating: false, error: true });
  });
});
