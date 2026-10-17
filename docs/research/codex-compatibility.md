# Codex compatibility research

## Scope

This research records host-local control-path evidence for `REQ-LH-002` and `REQ-LH-003`. It does not define a product adapter or claim support for existing desktop-session control without same-instance evidence.

## Official protocol baseline

OpenAI Docs document Codex app-server as a bidirectional JSON-RPC interface with `stdio://` JSONL, Unix-socket WebSocket, and experimental WebSocket transports. The same documentation defines `thread/start`, `turn/start`, streamed item events, approval request callbacks, and `turn/interrupt`; it also states that app-server and WebSocket transport are experimental and intended primarily for development/debugging. See [Codex App Server](https://learn.chatgpt.com/docs/app-server) and [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference).

The official model page confirms that `gpt-5.6-luna` supports reasoning effort `max`; the local app-server `model/list` response independently returned that model and effort. See [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

## Host facts

The host has Homebrew `codex-cli 0.162.1` and the ChatGPT desktop embedded CLI `codex-cli 0.163.0-alpha.10.2`. The desktop application runs an embedded app-server process, but its local Unix endpoints are anonymous IPC channels owned by the desktop process; no path-addressable app-server listener was found through the documented managed control socket.

The documented managed control socket was absent initially. A temporary `codex remote-control start --json` created a managed daemon running app-server `0.163.0` and a local socket, but `codex remote-control pair --json` returned `remote control pairing is unavailable until enrollment completes`. This proves daemon startup, not remote enrollment or desktop-thread sharing. The temporary daemon was stopped after probing, and its process and managed socket were verified absent; no global configuration or authentication state was changed.

## New-session result

The desktop-embedded CLI started as a separate host-local `codex app-server --listen stdio://` process in `/private/tmp/loomhelm-r01-codex-test`. The probe completed `initialize`, `model/list`, `thread/start`, and `turn/start` with `model=gpt-5.6-luna` and `effort=max`; it observed a real `thread/started`, `turn/started`, streamed `item/agentMessage/delta`, and `turn/completed` with status `completed`. The event evidence stores only stable hashes of thread/session/turn identifiers.

This establishes the selected-host new-session protocol path for the current CLI build. It does not establish that a Connector can attach to an existing desktop process or that a thread created by an independent app-server is the same live desktop instance.

The companion control probe also passed on the new-session path: it observed a real approval request and accepted harmless command, a declined harmless command, an interrupted long-running command, then a fresh app-server connection resuming the same thread and reconciling three persisted turns. The redacted run summary is [host-control-summary.md](../../experiments/codex/evidence/host-control-summary.md); the full summary can be regenerated into a disposable path with `control-probe.mjs`.

## Existing desktop-session result

The owner authorized one disposable desktop target, `Loomhelm R01`, with a projectless Codex thread and the fixed `gpt-5.6-luna/max` model. The redacted target reference is `thread-bd8358fda03363e67e`; its initialization turn is `turn-f8f1497b700c04cb74`, which completed with the fixed marker `R01_DESKTOP_TEST_READY`.

The native Codex app bridge then sent the fixed no-tool prompt `Reply with exactly R01_DESKTOP_BRIDGE_OK and do not use tools.` to that target and read the resulting `turn-617e4cdac2ddcc2316`, which completed with `R01_DESKTOP_BRIDGE_OK`. This proves that the app-internal bridge can target the designated thread, create a new turn, and read its result. The bridge is preparation evidence only: it is a Codex app capability, not a path-addressable host Connector endpoint that Loomhelm can reuse.

External control of the existing desktop session is still not proven. The documented managed daemon is not enrolled for pairing, the desktop app's embedded app-server is not exposed at the documented control socket, and no reusable host connection can attach to the same live desktop thread/turn. Approval, denial, interrupt, disconnect/restart reconciliation, and live event streaming therefore remain unverified on the external path. The redacted native-bridge preparation card is [desktop-bridge-summary.md](../../experiments/codex/evidence/desktop-bridge-summary.md).

The current acceptance state is therefore `blocked` for the second path. The blocker is an unavailable verified host attachment point to the same active desktop thread/turn, not a protocol-schema gap. History reads, `thread/read`, `thread/resume`, forks, the app-internal bridge, or another independent app-server are explicitly excluded as substitutes. Do not mark `REQ-LH-002` or `VER-LH-002` passed until the same-instance thread/turn identity is observed across a reusable live control connection and the required approval/interrupt/restart reconciliation scenarios complete.

## Evidence handling

Evidence should be generated into a disposable path with `new-session-probe.mjs --evidence <path>` or `control-probe.mjs --evidence <path>`. Do not commit raw app-server transcripts, rollout files, session databases, access tokens, pairing codes, or complete user messages. A valid evidence card must identify the candidate SHA, acceptance contract digest, scenario-set digest, and inspectable redacted evidence locator.
