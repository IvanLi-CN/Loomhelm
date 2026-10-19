# Desktop bridge preparation summary

This card records the owner-authorized preparation of one disposable desktop Codex target. It is deliberately separate from the host-local app-server control evidence and does not claim the existing-desktop acceptance passed.

| Field | Redacted result |
| - | - |
| Target | `Loomhelm R01` projectless desktop thread |
| Model | `gpt-5.6-luna` with reasoning effort `max` |
| Target reference | `thread-bd8358fda03363e67e` |
| Initial turn | `turn-f8f1497b700c04cb74`, completed with `R01_DESKTOP_TEST_READY` |
| Bridge transport | Native Codex app bridge (`mcp__codex_app__send_message_to_thread` / `read_thread`) |
| Bridge turn | `turn-617e4cdac2ddcc2316`, completed with `R01_DESKTOP_BRIDGE_OK` |
| Same-thread correlation | `true` |
| Host Connector attachment | `false` |
| Approval/denial, interrupt, restart reconciliation | `unverified` |

The bridge send/read operation confirms that the designated target accepts a fixed message and produces a real turn on the same thread. The bridge is an app-internal capability and is not a documented, path-addressable endpoint available to a future Loomhelm Connector. The desktop app's embedded app-server still exposes only anonymous process-owned IPC in this test environment; the managed remote-control daemon remains unenrolled, and the temporary probe daemon was stopped with its socket verified absent.
