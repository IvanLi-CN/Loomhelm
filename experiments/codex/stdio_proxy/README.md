# Loomhelm stdio proxy prototype

This directory contains a bounded, launch-time prototype for the R01 priority path: one pinned Codex app-server child remains the Desktop-owned process, while a Loomhelm bridge becomes a second logical client over a private Unix socket.

This is an unsupported experiment and does not pass the R01 same-instance acceptance gate. It has not replaced, restarted, or attached to the live ChatGPT Desktop process.

## Layout

- `proxy.go` and `framing.go` implement the standard-library-only proxy library.
- `cmd/stdio-proxy` is the wrapper entrypoint used by the launch scripts.
- `proxy_test.go` uses a controlled Go test binary as a mock child process.
- `scripts/test-once-r01.sh` runs the deterministic prototype tests and builds the wrapper.
- `scripts/launch-r01.sh` and `scripts/rollback-r01.sh` are reviewable, guarded Desktop startup scripts; neither is run by the test suite.

## Contract

The wrapper receives the Desktop-generated argv unchanged and only enters proxy mode when one argument is exactly `app-server`; every other invocation is transparently executed by the pinned child. The child inherits the current working directory and stderr, and the wrapper passes every inherited environment entry except its own `LOOMHELM_STDIO_PROXY_*` controls; `CODEX_CLI_PATH` is replaced with the pinned real child path to prevent recursive wrapping while `CODEX_APP_TOOLS_PIPE_PATH` and other unrelated plugin environment remain intact.

Proxy mode starts exactly one child, exposes one user-private Unix socket, and never respawns the child. The socket directory must be mode `0700` and the socket is forced to mode `0600`; an existing path is rejected instead of removed. A bridge disconnect removes only bridge-owned pending routes and does not signal the child or Desktop stream. A child exit closes the bridge and ends the generation; a later process is a new candidate and requires fresh evidence.

The Desktop owns the `initialize` request and must complete both the successful response and the `initialized` notification before bridge requests are accepted. A bridge `initialize` request is answered locally and is never forwarded to the child. Original client IDs are restored on the client-facing response; child-facing IDs use the reserved `loomhelm-proxy:` namespace, and a child server request using that reserved namespace is rejected to prevent collisions.

Child notifications without an ID are delivered to Desktop and the current bridge in child order. `userVerification`, account, plugin, and MCP callback methods remain Desktop-only. Ordinary methods ending in `requestApproval` are delivered to both clients with independent IDs; the first structurally valid result or error response is forwarded once, while invalid, late, and duplicate responses are ignored. Unclassified child server requests are Desktop-only until their ownership is explicitly decided.

The proxy has no retry path for protocol writes. If a write fails after any bytes were accepted, the log marks the side effect status as unknown and the proxy never resends that frame. A bounded bridge queue disconnects a slow bridge when full rather than growing memory without limit; Desktop output remains ordered and directly backpressured.

JSONL is treated as one JSON object per line because that is the app-server stdio transport used by this experiment. JSON-RPC batch arrays and a general capability negotiation layer are deliberately not implemented; those are protocol decisions that must be resolved against a pinned Desktop/CLI contract before production work. Non-JSON child lines are only broadcast as opaque diagnostic frames in the prototype and are not evidence of app-server compatibility.

## Verification

Run `./experiments/codex/stdio_proxy/scripts/test-once-r01.sh` from the repository root, or run `go test -count=1 ./experiments/codex/stdio_proxy/...` directly. The fixture tests cover initialization ownership, colliding original IDs, ordered unknown notifications, concurrent duplicate approvals, owner-bound callbacks, bridge disconnect/reconnect, child exit, signal forwarding, socket permissions, bounded backpressure, partial-write unknown status, argv/environment/cwd preservation, transparent invocation, and recursion rejection.

The scripts print the exact scoped Desktop command by default. Applying either script requires `LOOMHELM_R01_OWNER_CONFIRMED=1`, `LOOMHELM_R01_IDLE_WINDOW_CONFIRMED=1`, and `LOOMHELM_R01_ALLOW_RESTART=1`; the rollback script also refuses to proceed while its exact test socket path exists. Neither script kills processes, changes launchctl, changes global configuration, logs in, pairs a device, or cleans up another app-server.

## One-time Desktop test steps

1. Run `scripts/test-once-r01.sh` and record its wrapper SHA256, the repository SHA, and the test output summary.
2. Set `LOOMHELM_R01_WRAPPER` to that built wrapper, `LOOMHELM_R01_REAL_CLI` to the pinned bundled CLI regular file, `LOOMHELM_R01_SOCKET` to a new short path inside a `0700` user-private directory, and `LOOMHELM_R01_DESKTOP_EXECUTABLE` to the exact Desktop executable under test.
3. Review `scripts/launch-r01.sh --print`, confirm the affected Desktop application is disposable and idle, and separately confirm that no other active task or Desktop app-server is in scope.
4. Only after that owner confirmation, run `scripts/launch-r01.sh --apply`; record the wrapper PID, child PID, socket mode, exact thread/turn IDs, streamed ordering, approval arbitration, owner callback behavior, bridge reconnect, and child exit status.
5. Treat any lost acknowledgement as an unknown side effect and stop the test; do not resend the request. Do not claim R01 unless the exact same child PID and thread/turn identity are observed from both Desktop and bridge.
6. End the disposable test session, verify only the exact wrapper socket is absent, review `scripts/rollback-r01.sh --print`, and use `--apply` only with the same owner and idle-window confirmations.
