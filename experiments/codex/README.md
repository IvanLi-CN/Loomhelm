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

The probe is not evidence for live control of an already active desktop thread. That path requires a separately identified disposable desktop test session and a connection that attaches to the same live thread and turn; `thread/read`, history listing, fork, resume-only access, or a second independent app-server process do not satisfy that acceptance.

The owner-designated disposable target `Loomhelm R01` is now identified by the redacted reference `thread-bd8358fda03363e67e`. The native Codex app bridge created and read a second turn on that same target (`turn-617e4cdac2ddcc2316`) with the fixed marker `R01_DESKTOP_BRIDGE_OK`; this is app-internal preparation evidence only, not a reusable host Connector path. The redacted card is [desktop-bridge-summary.md](evidence/desktop-bridge-summary.md).

The latest control run passed with the same redacted thread/session reference across the initial and restarted connections. It observed `approval_requested` followed by `accept` and `command_completed=completed`, `decline` and `command_completed=declined`, `turn/completed=interrupted`, then `thread_resumed_after_restart.sameThread=true` and three reconciled turn statuses. The run summary is recorded in [host-control-summary.md](evidence/host-control-summary.md).

## Current entry-point facts

| Surface | Observed fact |
| - | - |
| Homebrew CLI | `codex-cli 0.162.1` at `/opt/homebrew/bin/codex` |
| Desktop embedded CLI | `codex-cli 0.163.0-alpha.10.2` at `CODEX_CLI_PATH` |
| Managed daemon | `0.163.0` can start a local control socket, but pairing reports that enrollment is incomplete; the temporary probe daemon was stopped and its socket verified absent |
| Default control socket | `/Users/ivan/.codex/app-server-control/app-server-control.sock` was absent before and after the temporary daemon probe; read-only proxy/version checks returned `ENOENT` |
| Official transports | `stdio://`, Unix socket, and experimental WebSocket are documented for app-server |

The authoritative protocol reference is the [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server); the CLI entry points are in the [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference). The documentation describes app-server as experimental/development-oriented and does not establish that a desktop application's existing active thread is externally attachable.

The bounded attachment follow-up is recorded in [desktop-attachment-follow-up.md](evidence/desktop-attachment-follow-up.md). It found no path-addressable listener for the live desktop app-server; `proxy --sock` and `daemon version` both failed against the absent managed socket. The only remaining lead requires an owner-authorized endpoint exposure or managed remote-control enablement/enrollment, so the existing-desktop path remains blocked.
