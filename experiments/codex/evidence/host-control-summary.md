# Host control evidence summary

This is a redacted summary of the host-local `stdio://` control run. It is evidence for the selected-host new-session path only and does not satisfy existing desktop-session sharing.

| Field | Observed value |
| - | - |
| CLI | `0.163.0-alpha.10.2` from `CODEX_CLI_PATH` |
| Model and effort | `gpt-5.6-luna` and `max` |
| Transport | host-local `codex app-server --listen stdio://` |
| Workspace | `/private/tmp/loomhelm-r01-codex-test` |
| Thread reference | `thread-90018dc00dc6ea55` |
| Session reference | `session-90018dc00dc6ea55` |
| Final turn reference | `turn-bff3e8d8eefdb385` |

The initial connection created the thread and completed three turns. The first command approval received `accept` and ended with `command_completed=completed`; the second received `decline` and ended with `command_completed=declined`; the third received `accept`, then a `turn/interrupt` request, and ended with `turn/completed=interrupted`.

The initial app-server process then exited. A restarted app-server resumed the same thread reference with `sameThread=true` and reconciled three persisted turn statuses: `interrupted`, `completed`, `completed`.

The exact reproducible command is `node experiments/codex/control-probe.mjs --workspace /private/tmp/loomhelm-r01-codex-test --evidence /private/tmp/loomhelm-r01-control-evidence.json`. The generated JSON contains only stable truncated SHA-256 references, event names, statuses and command digests; raw IDs, credentials, rollout files and complete message content are not committed.

The existing desktop-session path remains blocked because no path-addressable attachment to the same active desktop thread/turn was available. The owner-designated disposable desktop target and native app-bridge preparation are recorded separately and do not satisfy reusable host Connector control.
