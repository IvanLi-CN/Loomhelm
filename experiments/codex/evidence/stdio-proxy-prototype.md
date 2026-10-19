# R01 stdio proxy prototype evidence

This card records the owner-authorized isolated Go proxy phase for R01. It is correctness evidence for a controlled child process only and does not claim attachment to, replacement of, or control over the live ChatGPT Desktop app-server.

| Field | Recorded value |
| - | - |
| Candidate source commit | `52e46937542f143c5ec00cacdee3a75f550a3e0a` |
| Research parent commit | `9d0fcf71b323f04d4915849703da6e4632132ac5` |
| Host build | `go1.27.2 darwin/arm64` |
| Wrapper SHA256 | `9a57c3bc4f525c60a45fb48f95f5590217cec0f674a72e49285dbfd57caaa0a2` |
| Evidence command | `./experiments/codex/stdio_proxy/scripts/test-once-r01.sh` |
| Result | `prototype_result=passed` |
| Desktop integration | `not run` |
| R01 same-instance acceptance | `not passed` |

The candidate script ran `go test -count=1 ./experiments/codex/stdio_proxy/...`, built the wrapper from `cmd/stdio-proxy`, printed the wrapper digest and source commit, and removed the temporary build directory. The same candidate source also passed `go test -race -count=1 ./experiments/codex/stdio_proxy/...`, `go vet ./experiments/codex/stdio_proxy/...`, `git diff --check`, and `sh -n experiments/codex/stdio_proxy/scripts/*.sh` before commit.

The fixture scenarios passed initialization ownership, colliding original IDs, ordered unknown notifications, concurrent duplicate approval responses, owner-bound `userVerification` routing, bridge disconnect and reconnect, child exit without respawn, signal forwarding, private socket modes, bounded bridge queue behavior, partial-write unknown-side-effect handling, argv/environment/cwd preservation, transparent non-`app-server` execution, and recursion rejection. The fixture child is a controlled Go test subprocess; it is not the bundled Codex CLI.

The prototype uses one pinned child and one private Unix socket. It restores original client IDs, reserves the `loomhelm-proxy:` child namespace, delivers ordinary `requestApproval` callbacks to both logical clients with first-valid-response-wins semantics, keeps account/plugin/MCP/`userVerification` callbacks Desktop-only, and never retries a frame after partial delivery. A slow bridge is disconnected when its bounded queue fills; the Desktop stream remains ordered and directly backpressured.

Residual risks are intentionally open: the method ownership classifier is a conservative name-based prototype policy, JSON-RPC batches and a capability negotiation layer are not implemented, the child protocol is not validated against the pinned bundled CLI, Unix socket path length and directory policy must be checked on the target host, and real Desktop startup may have additional environment or lifecycle behavior. These risks are not waived by this evidence.

No wrapper was installed, no ChatGPT Desktop process was restarted or signaled, no login or pairing was performed, no global configuration was changed, and no other app-server or task was touched. The guarded launch and rollback scripts are [launch-r01.sh](../stdio_proxy/scripts/launch-r01.sh) and [rollback-r01.sh](../stdio_proxy/scripts/rollback-r01.sh); their `--print` mode is review-only and their `--apply` mode requires explicit owner, idle-window, restart, and digest confirmations.
