# Codex control-path experiments

This directory contains the smallest reproducible probes for the phase-one Codex compatibility acceptance. The probes use a disposable workspace, keep the requested model fixed at `gpt-5.6-luna` with reasoning effort `max`, and write only redacted event summaries.

The new-session probe starts a host-local `codex app-server --listen stdio://`, performs the `initialize` handshake, discovers the requested model, creates a new thread, starts one no-tool turn, and records the streamed lifecycle events through `turn/completed`.

The control probe extends the same host-local path with one accepted command approval, one declined command approval, an interrupt of a long-running harmless command, and a fresh app-server connection that resumes the same thread and lists its persisted turn history.

Run it with the desktop-embedded CLI when available:

```sh
node experiments/codex/new-session-probe.mjs \
  --workspace /private/tmp/loomhelm-r01-codex-test \
  --evidence /private/tmp/loomhelm-r01-new-session-evidence.json

node experiments/codex/control-probe.mjs \
  --workspace /private/tmp/loomhelm-r01-codex-test \
  --evidence /private/tmp/loomhelm-r01-control-evidence.json
```

`CODEX_CLI_PATH` is used by default when set; otherwise the probe falls back to `codex` on `PATH`. The probe removes only task-runner marker variables from the child environment and does not read or modify authentication files or global configuration.

Thread, session and turn identifiers are represented by stable truncated SHA-256 references so that the event ordering and identity correlation remain reviewable without publishing raw identifiers. The fixed prompt is intentionally non-destructive and forbids tool use.

The probe is not evidence for live control of an already active desktop thread. That path requires a separately identified disposable desktop test session and a connection that attaches to the same live thread and turn; `thread/read`, history listing, fork, or an independent app-server cold resume do not satisfy that acceptance. A warm resume on the same app-server process can be valid, but it must preserve live conversation and pending request ownership.

The owner-designated disposable target `Loomhelm R01` is now identified by the redacted reference `thread-bd8358fda03363e67e`. The native Codex app bridge created and read a second turn on that same target (`turn-617e4cdac2ddcc2316`) with the fixed marker `R01_DESKTOP_BRIDGE_OK`; this is app-internal preparation evidence only, not a reusable host Connector path. The redacted card is [desktop-bridge-summary.md](evidence/desktop-bridge-summary.md).

The latest control run passed with the same redacted thread/session reference across the initial and restarted connections. It observed `approval_requested` followed by `accept` and `command_completed=completed`, `decline` and `command_completed=declined`, `turn/completed=interrupted`, then `thread_resumed_after_restart.sameThread=true` and three reconciled turn statuses. The run summary is recorded in [host-control-summary.md](evidence/host-control-summary.md).

## Current entry-point facts

| Surface | Observed fact |
| - | - |
| Homebrew CLI | `codex-cli 0.162.1` at `/opt/homebrew/bin/codex` |
| Desktop embedded CLI | `codex-cli 0.163.0-alpha.10.2` at `CODEX_CLI_PATH` |
| ChatGPT desktop bundle | `26.1013.31256` build `20586`; app.asar `bf9c41fa9770fbfacfba93042ff71c24cb65c82935819377275faac08103383f` |
| Managed daemon | `0.163.0` can start a local control socket, but pairing reports that enrollment is incomplete; the temporary probe daemon was stopped and its socket verified absent |
| Default control socket | `/Users/ivan/.codex/app-server-control/app-server-control.sock` was absent before and after the temporary daemon probe; read-only proxy/version checks returned `ENOENT` |
| Live desktop child | PID `10095`, private `app-server` stdio without `--listen`; `CODEX_CLI_PATH` and `CODEX_APP_TOOLS_PIPE_PATH` set; `mcp_servers.codex_app` override present in argv |
| Wrapper entry | Bundle accepts an absolute regular-file `CODEX_CLI_PATH` and passes generated argv/env to it; the isolated Go wrapper was tested, but no wrapper was installed or executed against Desktop |
| SSH proxy entry | Bundle checks `CODEX_SSH_SKIP_APP_SERVER_BOOT=true`, then can run remote `codex app-server proxy`; it still requires an existing managed Unix socket |
| Official transports | `stdio://`, Unix socket, and experimental WebSocket are documented for app-server |

The authoritative protocol reference is the [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server); the CLI entry points are in the [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference). The documentation describes app-server as experimental/development-oriented and does not establish that a desktop application's existing active thread is externally attachable.

The bounded attachment follow-up is recorded in [desktop-attachment-follow-up.md](evidence/desktop-attachment-follow-up.md). It found no path-addressable listener for the live desktop app-server; `proxy --sock` and `daemon version` both failed against the absent managed socket. The follow-up now ranks a launch wrapper first for a disposable one-restart PoC, the shared daemon second, and forced WebSocket/SSH proxy third. The first-party [Remote connections](https://learn.chatgpt.com/docs/remote-connections) flow is documented for ChatGPT device connections, but it does not document a third-party Connector endpoint or thread/turn protocol. The existing-desktop path remains unverified until one of the controlled candidates demonstrates same-process thread/turn identity and callback ownership.

The isolated Go proxy correctness gate is recorded in [stdio-proxy-prototype.md](evidence/stdio-proxy-prototype.md). It validates the launch-time child and protocol-multiplexing contract against a controlled mock child, but it does not pass the existing-desktop same-instance gate.
