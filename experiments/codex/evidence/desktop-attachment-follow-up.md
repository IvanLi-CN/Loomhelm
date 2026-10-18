# Desktop attachment follow-up

This is a bounded read-only follow-up for the owner-designated `Loomhelm R01` target. It records supported local entry points and the exact remaining blocker; it does not send a message, start a daemon, enable remote control, pair, enroll, restart the desktop app, or change global configuration.

| Route | Local result | Acceptance status |
| - | - | - |
| Embedded desktop app-server | CLI `0.163.0-alpha.10.2`, process-owned anonymous Unix descriptors, no `--listen` argument, no TCP listener | Same-instance process exists, but no reusable endpoint |
| Generic `app-server --listen` | Supported for an app-server process launched with a listener; the current desktop process was started without it and no supported post-start addition was found | New-session transport capability only; not evidence for current desktop attachment |
| `app-server proxy --sock` | Default `/Users/ivan/.codex/app-server-control/app-server-control.sock` absent; proxy returned `ENOENT` | Exhausted for the currently documented socket |
| `app-server daemon version` | Failed to connect to the same absent managed control socket with `ENOENT` | Exhausted as a read-only discovery route |
| `codex queue --thread --remote` | Supported syntax requires an already available `unix://PATH`, `ws://`, or `wss://` endpoint; no endpoint exists to test | Concrete client route, blocked by missing endpoint |
| `codex --remote unix://PATH` or `ws://...` | Supported syntax requires an already available app-server listener | Concrete client route, blocked by missing endpoint |
| Managed remote-control | Earlier start created a separate temporary daemon; pairing reported enrollment incomplete; daemon and socket were stopped and verified absent | Separate managed app-server; not evidence for current desktop attachment |
| Native Codex app bridge | Sent/read a marker on the designated thread | Preparation only; excluded from Connector acceptance |
| Independent stdio app-server | Passed new-session approval, denial, interrupt and restart reconciliation | New-session path only; excluded from existing-desktop acceptance |

The official CLI reference documents `app-server` listeners, `--remote`, `queue --thread`, and managed `remote-control`; the app-server documentation describes `thread/resume` as continuation of a stored thread and does not provide an existing desktop-process attachment method. See [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference) and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The official [Remote connections](https://learn.chatgpt.com/docs/remote-connections) page describes the first-party desktop `Settings > Connections` flow: account/workspace verification, QR pairing, secure relay, and prompts, approvals and follow-up messages to the connected host. It does not document a third-party Connector endpoint, app-server URI, thread/turn RPC, or Connector authentication contract, so this first-party flow is not evidence for Loomhelm's Go Connector. The current version and configuration have no proven official hot-attach method for the existing desktop app-server. This is a current evidence boundary, not a claim that future versions can never support one; the unresolved item is whether a future documented third-party endpoint or desktop startup integration will preserve the same live thread identity.
