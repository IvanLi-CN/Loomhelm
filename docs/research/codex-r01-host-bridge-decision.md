# R01 Host Bridge Decision Card

R01 separates two decisions: an independent Loomhelm Host Bridge that owns its app-server process is technically reproducible, while hot-attaching the currently running ChatGPT Desktop app-server is not supported by the observed runtime contract.

| Field | Decision |
| - | - |
| `supported_baseline` | A Go Host Bridge starts one pinned bundled Codex CLI app-server child, owns that child lifecycle, and exposes a private logical bridge client over a mode-0600 Unix socket; direct `stdio://`, direct Unix WebSocket, and direct TCP WebSocket app-server transports are available for host-owned sessions. |
| `optional_paths` | A future owner-approved Desktop launch-wrapper experiment, a separately started shared managed daemon, or an explicitly provisioned Unix/WebSocket app-server endpoint can be evaluated for new sessions; none is current Desktop hot-attach support. |
| `blocked_paths` | Attaching to the current Desktop child, using `codex_app` as a general third-party control API, treating `thread/resume` in a new process as active-turn attachment, and relying on this CLI's `app-server proxy --sock` helper are blocked by current evidence. |
| `required_runtime_contract` | One exact CLI identity, one child generation, private transport ownership, Desktop initialization ownership, deterministic approval arbitration, owner-bound callback routing, durable operation/event records, and explicit cold-resume reconciliation. |
| `R01_status` | `blocked` for current Desktop acceptance; `supported_baseline` for an independent host-owned app-server runtime. |

## Installed Runtime

The exact bundled executable used in this run is `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, SHA256 `1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe`, reporting `codex-cli 0.163.0-alpha.10.2`.

The fresh Go wrapper was built from source commit `7ff2b867a60c63acaccd1b34586b1581596a7af7` with `go1.27.2 darwin/arm64`; its temporary executable SHA256 is `89ac244c80640ee0ad5c6e41561e588bae9925b45ff3d19b41e97f073df8fd39`.

The installed CLI advertises `stdio://` as the default app-server transport, `unix://` and `unix://PATH`, `ws://IP:PORT`, and `off`; `app-server proxy --sock PATH` is a separate helper entry point. The official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) and [CLI reference](https://learn.chatgpt.com/docs/cli/reference) describe these as app-server/client transports, not as a discovery API for an existing private Desktop process.

## Transport Results

The direct transport smoke passed `initialize` and `model/list` with eight advertised models for all three direct transports: child stdio, a raw WebSocket Upgrade over a Unix socket, and TCP WebSocket.

The same CLI's `app-server proxy --sock` helper produced no JSON-RPC response within five seconds while the direct Unix WebSocket endpoint succeeded. This is recorded as a helper-specific compatibility issue, not as Unix transport failure; the behavior is consistent with the upstream [proxy WebSocket framing issue](https://github.com/openai/codex/issues/25846).

The direct Unix result means a Host Bridge must implement WebSocket-over-HTTP-Upgrade framing when it dials an app-server Unix endpoint, or must separately verify a proxy helper version that actually forwards the protocol. The Go prototype's private bridge socket is a different JSONL logical-client protocol and must not be confused with the Codex app-server Unix transport.

## Control Results

The fresh wrapper run used one Go wrapper child and two logical clients, a Desktop-role stdio client and a private Unix bridge client, against the exact bundled CLI with `gpt-5.6-luna` and reasoning effort `max`.

The run passed Desktop-owned initialization, bridge initialization rejection with `-32002`, model capability discovery, same-thread event fan-out, Desktop approval accept, bridge approval decline with a late Desktop response, pending approval reconciliation after bridge disconnect, bridge reconnect on the same child and thread, `turn/steer`, and `turn/interrupt` with both clients observing `interrupted`.

The wrapper restart run completed one real no-tool turn in generation one, stopped that wrapper and its app-server child, started generation two with the same host Codex state, and restored the same redacted `thread_id` through the private bridge with one persisted turn. This proves cold restoration after a Host Bridge/app-server generation change; it does not claim that an in-progress turn or a pending owner-bound callback survives process replacement.

The direct app-server restart run completed one real turn, stopped the app-server, started a new process, called `thread/resume` with the original redacted `thread_id`, and read one persisted turn. No Desktop auth file was copied and no Desktop process was launched, restarted, signaled, or reconfigured; the restart check used the existing host CLI auth location only for the independent CLI process.

## Desktop Boundary

Read-only inspection of the current Desktop found the embedded CLI running as a private `app-server` stdio child without `--listen`; its Unix descriptors were anonymous process-owned channels, and the documented managed control socket was absent. No path-addressable listener was available for a third-party Host Bridge.

The current Desktop command line enables the bundled `codex_app` plugin and carries `CODEX_APP_TOOLS_PIPE_PATH`; the packaged app reads that pipe and emits `mcp_servers.codex_app` request-level overrides. This is Desktop-owned plugin/application plumbing, not a documented app-server listener or a general thread/turn control API. The isolated Host Bridge did not use or impersonate this plugin.

The packaged Desktop bundle contains a local-daemon selector and external WebSocket hooks, but the observed startup has plugin/config overrides and a private stdio child, so those branches cannot be treated as the current process's endpoint. The shared daemon remains an optional future startup topology that requires explicit configuration and restart; its existence does not attach a bridge to the already running Desktop child. The upstream [app-server daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md) also describes daemon restart as a lifecycle boundary that can interrupt active or queued work.

## Runtime Contract

The Host Bridge must pin the exact CLI path, version and digest before starting a generation, reject wrapper recursion, preserve the child argv/cwd/environment contract, and expose only a private mode-0600 bridge socket under a mode-0700 directory.

The wrapper owns exactly one app-server child generation, forwards signals and waits for child exit, does not respawn silently, removes its private socket on exit, and treats a replacement process as a new generation requiring fresh identity and state reconciliation.

Desktop-role initialization remains the physical child-client owner; a bridge client must not initialize the child independently. Ordinary approval requests may be fanned out with first-valid-response-wins semantics and late responses must be ignored. `userVerification`, account login, MCP/plugin callbacks and other owner-bound requests remain Desktop-owned and unavailable for remote approval unless an explicit protocol contract says otherwise.

Every send, approval, interrupt, child generation and observed event must have a durable operation identity and reconciliation record. After a bridge or app-server restart, restore by `thread/resume` and history/status reads, show unknown when side effects are not confirmed, and never replay a command solely because an ACK was lost. A persisted thread after a new process is cold recovery, not proof of control over the old active turn.

The model contract used by this evidence is fixed at `gpt-5.6-luna` with reasoning effort `max`; production policy must still define auth ownership, identity challenges, workspace/sandbox policy, network policy, approval policy, and the compatibility window for CLI upgrades.

## Evidence

| Evidence | Result and locator |
| - | - |
| Direct transports and app-server restart | `passed`; `/private/tmp/loomhelm-r01-host-bridge.tf7Ytl/transport-restart-evidence.json`; SHA256 `abde329228db77d8aa65b9a56f93aa6d73762dbe4a9ace4e8281fe9d96b6b20d`. |
| Fresh real-CLI wrapper control | `passed`; `/private/tmp/loomhelm-r01-host-bridge.tf7Ytl/real-cli-probe/evidence-fresh-extended.json`; SHA256 `209b5fab1784ca71e944709f88f0d649e20311753e89b4b01acc4a0ce9e5c700`. |
| Two-generation Go Host Bridge restart | `passed`; `/private/tmp/loomhelm-r01-host-bridge.tf7Ytl/bridge-restart-evidence.json`; SHA256 `033cfb48058cb1474ccfc1dfe283b9628901d56c4b32977053ebe531f8a23ecb`. |
| Fresh wrapper executable | `/private/tmp/loomhelm-r01-host-bridge.tf7Ytl/stdio-proxy`; SHA256 `89ac244c80640ee0ad5c6e41561e588bae9925b45ff3d19b41e97f073df8fd39`; source SHA `7ff2b867a60c63acaccd1b34586b1581596a7af7`. |
| Existing Desktop baseline | [codex-compatibility.md](codex-compatibility.md), [desktop-attachment-follow-up.md](../../experiments/codex/evidence/desktop-attachment-follow-up.md), and [desktop-attach-handoff.md](../../experiments/codex/evidence/desktop-attach-handoff.md). |
| Related isolated control evidence | [real-cli-proxy-isolated.md](../../experiments/codex/evidence/real-cli-proxy-isolated.md) and [stdio-proxy-prototype.md](../../experiments/codex/evidence/stdio-proxy-prototype.md). |

All evidence JSON is redacted: raw thread/session/turn identifiers are replaced with stable truncated references, paths are normalized to placeholders where appropriate, and no auth material, rollout transcript, or Desktop state was copied into the repository.

## Reproduction

Run the focused Go checks and build the wrapper in a disposable directory:

```sh
go test -count=1 ./experiments/codex/stdio_proxy/...
go build -o /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/stdio-proxy ./experiments/codex/stdio_proxy/cmd/stdio-proxy
```

Run the transport and app-server cold-recovery harness:

```sh
R01_ROOT=/private/tmp/loomhelm-r01-host-bridge.tf7Ytl \
R01_REAL_CLI=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
node /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/transport-restart-smoke.mjs
```

Run the two-generation Host Bridge recovery harness:

```sh
R01_ROOT=/private/tmp/loomhelm-r01-host-bridge.tf7Ytl \
R01_WRAPPER=/private/tmp/loomhelm-r01-host-bridge.tf7Ytl/stdio-proxy \
R01_REAL_CLI=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
node /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/bridge-restart-smoke.mjs
```

Run the full isolated real-CLI control probe against a previously built wrapper; the probe never launches or attaches to ChatGPT Desktop:

```sh
node experiments/codex/stdio_proxy/real-cli-proxy-probe.mjs \
  --root /private/tmp/loomhelm-r01-host-bridge.tf7Ytl \
  --wrapper /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/stdio-proxy \
  --real-cli /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  --socket /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/r01-proxy.sock \
  --evidence /private/tmp/loomhelm-r01-host-bridge.tf7Ytl/real-cli-probe/evidence.json \
  --timeout-ms 180000
```

The official protocol distinguishes cold thread restoration from sharing a live app-server thread; the upstream [thread queue test](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/thread_queue.rs) demonstrates `thread/resume` after a new app-server instance, while the current Desktop hot-attach path still lacks a verified endpoint and owner contract.
