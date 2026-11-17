// Stateful protocol fixture. It models documented sticky configuration;
// it does not run Codex, a model, tools, or a real filesystem sandbox.
import { readFileSync, writeFileSync } from "node:fs";

export function serveFixture(socketPath: string, statePath: string) {
  return Bun.serve({
    unix: socketPath,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      message(ws, text) {
        const row = JSON.parse(String(text));
        if (row.id === undefined) return;
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const params = row.params ?? {};
        state.calls.push({ method: row.method, params });
        let result: any;
        if (row.method === "initialize") {
          result = { userAgent: "Codex Desktop/0.169.0 (stateful fixture)" };
        } else if (row.method === "thread/resume") {
          if (params.threadId !== state.thread.id) throw new Error("Wrong thread");
          if (params.sandbox)
            state.policy = {
              type: {
                "read-only": "readOnly",
                "workspace-write": "workspaceWrite",
                "danger-full-access": "dangerFullAccess",
              }[params.sandbox],
            };
          if (params.approvalPolicy) state.approval = params.approvalPolicy;
          result = {
            thread: state.thread,
            sandbox: state.policy,
            approvalPolicy: state.approval,
            approvalsReviewer: "user",
            activePermissionProfile: null,
          };
        } else if (row.method === "thread/settings/update") {
          state.policy = params.sandboxPolicy;
          state.approval = params.approvalPolicy;
          if (params.sandboxPolicy.type === "readOnly") assertSnapshot();
          function assertSnapshot() {
            const ledger = JSON.parse(readFileSync(process.env.PROBE_LEDGER!, "utf8"));
            if (!ledger.operations[0].request.initialization_recovery.permissions.original)
              throw new Error("override before snapshot");
          }
          ws.send(
            JSON.stringify({
              method: "thread/settings/updated",
              params: {
                threadId: state.thread.id,
                threadSettings: {
                  sandboxPolicy: state.policy,
                  approvalPolicy: state.approval,
                  approvalsReviewer: "user",
                  activePermissionProfile: null,
                },
              },
            }),
          );
          result = {};
        } else if (row.method === "thread/read") {
          result = { thread: state.thread };
        } else if (row.method === "thread/turns/list") {
          result = { data: state.turns, nextCursor: null };
        } else if (row.method === "turn/start") {
          if (params.sandboxPolicy) state.policy = params.sandboxPolicy;
          if (params.approvalPolicy) state.approval = params.approvalPolicy;
          const recovery = String(params.input?.[0]?.text ?? "").startsWith("$multi-task-flow");
          const turn = {
            id: recovery ? "recovery-turn" : "formal-turn",
            status: "completed",
            itemsView: "full",
            items: [
              { type: "userMessage", content: params.input },
              { type: "agentMessage", text: recovery ? "READY" : "FIXTURE" },
            ],
          };
          state.contexts.push({
            turn_id: turn.id,
            sandbox_policy: {
              ...state.policy,
              type: {
                readOnly: "read-only",
                workspaceWrite: "workspace-write",
                dangerFullAccess: "danger-full-access",
                externalSandbox: "external-sandbox",
              }[state.policy.type],
            },
            approval_policy: state.approval,
          });
          state.turns.push(turn);
          result = { turn };
          setTimeout(() => {
            try {
              ws.send(
                JSON.stringify({
                  method: "turn/completed",
                  params: { threadId: state.thread.id, turn },
                }),
              );
            } catch {}
          }, 30);
        } else {
          throw new Error(`Unexpected method: ${row.method}`);
        }
        writeFileSync(statePath, JSON.stringify(state));
        ws.send(JSON.stringify({ id: row.id, result }));
      },
    },
  });
}
