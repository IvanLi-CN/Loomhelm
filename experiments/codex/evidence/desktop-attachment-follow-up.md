# Desktop attachment follow-up

This is a bounded read-only follow-up for the owner-designated `Loomhelm R01` target. It records supported local entry points and the exact remaining blocker; it does not send a message, start a daemon, enable remote control, pair, enroll, restart the desktop app, or change global configuration.

| Route | Local result | Acceptance status |
| - | - | - |
| Embedded desktop app-server | CLI `0.163.0-alpha.10.2`, process-owned anonymous Unix descriptors, no `--listen` argument, no TCP listener | Same-instance process exists, but no reusable endpoint |
| `app-server proxy --sock` | Default `/Users/ivan/.codex/app-server-control/app-server-control.sock` absent; proxy returned `ENOENT` | Exhausted for the currently documented socket |
| `app-server daemon version` | Failed to connect to the same absent managed control socket with `ENOENT` | Exhausted as a read-only discovery route |
| `codex queue --thread --remote` | Supported syntax requires an already available `unix://PATH`, `ws://`, or `wss://` endpoint; no endpoint exists to test | Concrete client route, blocked by missing endpoint |
| `codex --remote unix://PATH` or `ws://...` | Supported syntax requires an already available app-server listener | Concrete client route, blocked by missing endpoint |
| Managed remote-control | Earlier start created a temporary daemon; pairing reported enrollment incomplete; daemon and socket were stopped and verified absent | Exhausted without owner authorization for enrollment/pairing |
| Native Codex app bridge | Sent/read a marker on the designated thread | Preparation only; excluded from Connector acceptance |
| Independent stdio app-server | Passed new-session approval, denial, interrupt and restart reconciliation | New-session path only; excluded from existing-desktop acceptance |

The official CLI reference documents `app-server` listeners, `--remote`, `queue --thread`, and managed `remote-control`; the app-server documentation describes `thread/resume` as continuation of a stored thread and does not provide an existing desktop-process attachment method. See [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference) and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The remaining actionable decision is whether the owner will provide or authorize a path-addressable endpoint owned by the same desktop app-server instance. One possible route is managed remote-control enablement followed by enrollment/pairing and any required desktop restart; that changes global/managed state and may require identity participation, so it was not performed. A successful endpoint still must be correlated to `thread-bd8358fda03363e67e` and a live turn before the required control scenarios can run.
