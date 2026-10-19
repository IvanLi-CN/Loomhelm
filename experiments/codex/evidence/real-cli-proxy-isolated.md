# R01 retained real CLI proxy evidence

This card records the isolated retained-candidate probe against the exact bundled Codex CLI. It is stronger than the mock-child fixture proof because the app-server protocol, model discovery, approval callbacks, thread events, steering, interruption, and child lifecycle were exercised by the current real CLI, but it is still not Desktop acceptance evidence.

| Field | Recorded value |
| - | - |
| Candidate source commit | `c43e9cc5867b29d2b89e21e2415d0f8256815042` |
| Retained candidate | `/private/tmp/loomhelm-r01-codex-test/proxy-candidate-c43e9cc` |
| Candidate manifest | `/private/tmp/loomhelm-r01-codex-test/proxy-candidate-c43e9cc/manifest.env` |
| Wrapper SHA256 | `d4e2785e1cb320b0641255f7ba807c50951c54bc3f5ee47c265b7107e41c1790` |
| Exact bundled CLI | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` |
| Bundled CLI SHA256 | `1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe` |
| Bundled CLI version | `codex-cli 0.163.0-alpha.10.2` |
| Probe command | `node experiments/codex/stdio_proxy/real-cli-proxy-probe.mjs --stage-manifest /private/tmp/loomhelm-r01-codex-test/proxy-candidate-c43e9cc/manifest.env` |
| Redacted evidence JSON | `/private/tmp/loomhelm-r01-codex-test/real-cli-1792382833672-910a5714/evidence.json` |
| Evidence JSON SHA256 | `71d9b018d3a9db9c5a4783ac237d7c127d663a1800c9acd9b7d3d976f4814938` |
| Probe result | `passed` |
| Wrapper PID / real CLI child PID | `62280 / 62289` |
| Same thread reference | `thread-5a617140d07b6b48` |
| Same session reference | `session-5a617140d07b6b48` |
| Desktop integration | `not run` |
| R01 same-desktop acceptance | `not passed` |

The probe used one retained wrapper child and two logical clients: a Desktop-role stdin/stdout client and one private Unix-socket bridge. Desktop-role initialization completed, bridge initialization was rejected as Desktop-owned, and the bridge successfully observed `gpt-5.6-luna` with reasoning effort `max`. The same `thread/started` identity was observed by both clients while the wrapper and exact bundled CLI child remained unchanged; this client role was not the live Desktop application.

The real CLI scenarios passed: an ordinary approval accepted by Desktop completed the harmless printf command; a second approval declined by the bridge completed with `declined` after a late Desktop response; a pending approval remained recoverable by Desktop after bridge disconnect; bridge reconnect used the same child and thread and reconciled three turns with statuses `inProgress, completed, completed`; `turn/steer` returned the same active turn identity; and `turn/interrupt` completed with `interrupted` on both clients. No identity challenge was observed. The controlled probe ended the candidate process with exit code `130` after the scenarios; the wrapper removed its private socket.

The earlier retained candidate at source `320519d303170bc1134ac494afd55cbe2ff3ef74` was not accepted because its first approval event exceeded the initial 15-second probe wait; it produced no identity challenge or protocol error. The probe wait was widened to 45 seconds, a new candidate was staged, and only the SHA-bound `c43e9cc` run above is evidence.

Fixture proof remains separate in [stdio-proxy-prototype.md](stdio-proxy-prototype.md): it covers proxy mechanics against a controlled child. This card covers the current real bundled CLI in an isolated new app-server process. Neither card proves that the live ChatGPT Desktop app-server can be replaced or externally attached.

Desktop/plugin proof is pending: no `launch-r01.sh --apply`, Desktop quit/relaunch, startup replacement, native plugin bridge, approval callback, or live Desktop thread was run in this stage. The existing Desktop process was observed but not signaled; the exact test socket was absent after the probe and the managed socket remained absent. Same-desktop acceptance, plugin/app-tools behavior through a replaced Desktop startup, owner-bound `userVerification`, and any production support claim remain unresolved.

The concrete handoff is [stage-r01.sh](../stdio_proxy/scripts/stage-r01.sh), [capture-baseline-r01.sh](../stdio_proxy/scripts/capture-baseline-r01.sh), [launch-r01.sh](../stdio_proxy/scripts/launch-r01.sh), [verify-r01.sh](../stdio_proxy/scripts/verify-r01.sh), and [rollback-r01.sh](../stdio_proxy/scripts/rollback-r01.sh). `launch-r01.sh --print` and rollback preview are review-only; applying them still requires a separately confirmed owner idle/restart window and is outside this evidence.
