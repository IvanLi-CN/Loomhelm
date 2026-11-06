# R01 Desktop attach-only bridge handoff

Status: ready-for-owner-decision; this card records preparation only and contains no live Desktop verdict.

The affected scope is the entire ChatGPT Desktop application, including every currently open conversation, because launch-r01.sh --apply would require quitting and relaunching the application; the owner must choose a disposable idle window and perform every UI and application lifecycle action manually.

No Desktop process was quit, restarted, signaled, wrapped, or reconfigured during this preparation, and no current conversation was opened, sent to, moved, scheduled, paired, or otherwise mutated by the attach driver.

| Field | Bound value |
| - | - |
| Desktop executable | /Applications/ChatGPT.app/Contents/MacOS/ChatGPT |
| Retained manifest | /private/tmp/loomhelm-r01-codex-test/proxy-candidate-36d4fc3/manifest.env |
| Candidate source SHA | 36d4fc371a983ea0921e03091318eecf033d4355 |
| Retained wrapper | /private/tmp/loomhelm-r01-codex-test/proxy-candidate-36d4fc3/stdio-proxy |
| Retained wrapper SHA256 | 6ea84b92f5a208202489b217ecdfd27c087d76684b821b25a17c39c37014ca1e |
| Pinned real CLI | /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex |
| Pinned real CLI SHA256 | 1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe |
| Pinned real CLI version | codex-cli 0.163.0-alpha.10.2 |
| Existing isolated evidence | /private/tmp/loomhelm-r01-codex-test/real-cli-1792383022010-f414658f/evidence.json SHA256 97c73a029a8a74d91b1955fdf7c9f64f38f337d5260a6cf040cf5159a9637a97 |
| Attach driver | experiments/codex/stdio_proxy/attach-driver.mjs |
| Attach fixture | experiments/codex/stdio_proxy/attach-driver-fixture.mjs |

## Driver contract

The attach driver only dials an already existing private Unix socket; it never starts codex app-server, never starts any replacement process, never sends initialize or initialized, never lists or searches arbitrary threads, and never responds to an owner-bound callback.

Before connecting, the driver requires the exact retained manifest and recomputes both executable SHA256 values, checks the socket is mode 0600 under a mode 0700 directory, checks the test workspace is mode 0700, and verifies the exact process chain ChatGPT Desktop -> retained wrapper -> pinned real CLI.

The process check also verifies the wrapper environment bindings, the real CLI CODEX_CLI_PATH, absence of LOOMHELM_STDIO_PROXY_* controls in the child, and the real CLI cwd; optional --desktop-pid, --wrapper-pid, and --child-pid values bind the run to the PIDs printed by the read-only verification script.

Existing-thread scenarios first call thread/read for the supplied private thread identity and require the returned thread.id, exact thread.cwd, and direct-input readiness to match the dedicated workspace; the driver never calls thread/list, thread/resume against an unknown identity, fork, or history discovery.

The create-thread scenario uses only the explicit thread/start contract with gpt-5.6-luna, max turns, approvalPolicy=untrusted, sandbox=workspace-write, the exact cwd and runtime workspace root, then stores the raw thread ID only in a new mode-0600 thread file bound to the workspace and marker.

Evidence JSON contains candidate digests, event names, statuses, marker and command digests, and stable SHA-256 references for thread, turn, request, PID, socket, and workspace values; it does not contain raw thread IDs, request IDs, complete prompts, credentials, or app-server transcripts.

## Baseline provenance

The old /private/tmp/loomhelm-r01-codex-test/baseline-final.env was captured from the task shell and is not a valid owner Desktop baseline; the owner must capture a new file such as /private/tmp/loomhelm-r01-codex-test/desktop-baseline.env immediately before any future apply decision.

The recommended capture launcher is a fresh owner-opened external Terminal, because that gives the owner a known shell parent and makes the four captured variables reviewable without claiming to reconstruct hidden Finder or Electron state.

```sh
cd /Users/ivan/.codex/worktrees/ef29/loomhelm
test -d /private/tmp/loomhelm-r01-codex-test
test "$(stat -f '%Lp' /private/tmp/loomhelm-r01-codex-test)" = 700
test ! -e /private/tmp/loomhelm-r01-codex-test/desktop-baseline.env
LOOMHELM_R01_BASELINE_ENV_FILE=/private/tmp/loomhelm-r01-codex-test/desktop-baseline.env LOOMHELM_R01_BASELINE_PROVENANCE=owner-external-terminal ./experiments/codex/stdio_proxy/scripts/capture-baseline-r01.sh
```

The capture file records only CODEX_CLI_PATH, CODEX_APP_SERVER_FORCE_CLI, LOOMHELM_STDIO_PROXY_REAL_CLI, and LOOMHELM_STDIO_PROXY_SOCKET, preserving unset versus empty as **UNSET** and **EMPTY**; it must not be expanded to include unrelated environment variables or credentials.

Use owner-finder-launcher only when the owner has independently established that the relevant launch context really came from Finder, and use owner-unknown when the original parent context cannot be established; both values are honest provenance records, not proof that a hidden parent environment can be reproduced.

rollback-r01.sh --apply restores only those four captured variables in the invoking owner shell and then execs the normal Desktop executable; it does not reconstruct unknown Electron or Finder parent variables, launch services state, launchctl state, credentials, or global configuration, so owner-unknown cannot support an exact-environment reconstruction claim.

## Owner handoff

The following sequence is prepared for a future owner decision and has not been executed in this task.

First, the owner creates a new mode-0700 workspace and reviews a dry-run from that workspace so the eventual Desktop child inherits the exact dedicated cwd.

```sh
repo=/Users/ivan/.codex/worktrees/ef29/loomhelm
r01_root=/private/tmp/loomhelm-r01-codex-test
manifest=/private/tmp/loomhelm-r01-codex-test/proxy-candidate-36d4fc3/manifest.env
baseline=/private/tmp/loomhelm-r01-codex-test/desktop-baseline.env
socket=/private/tmp/loomhelm-r01-codex-test/desktop-attach.sock
workspace=/private/tmp/loomhelm-r01-codex-test/desktop-attach-workspace
test ! -e "$workspace"
mkdir -m 700 "$workspace"
export LOOMHELM_R01_STAGE_MANIFEST="$manifest"
export LOOMHELM_R01_BASELINE_ENV_FILE="$baseline"
export LOOMHELM_R01_SOCKET="$socket"
export LOOMHELM_R01_DESKTOP_EXECUTABLE=/Applications/ChatGPT.app/Contents/MacOS/ChatGPT
cd "$workspace"
"$repo/experiments/codex/stdio_proxy/scripts/launch-r01.sh" --print
```

The owner then decides whether the entire Desktop application is disposable and idle, manually quits it through the normal UI, verifies that no exact Desktop process remains, and only then chooses whether to run the guarded apply command below; this is the explicit mutation gate and is outside the work performed here.

```sh
cd "$workspace"
LOOMHELM_R01_OWNER_CONFIRMED=1 LOOMHELM_R01_IDLE_WINDOW_CONFIRMED=1 LOOMHELM_R01_ALLOW_RESTART=1 LOOMHELM_R01_WRAPPER_SHA256=6ea84b92f5a208202489b217ecdfd27c087d76684b821b25a17c39c37014ca1e LOOMHELM_R01_REAL_CLI_SHA256=1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe "$repo/experiments/codex/stdio_proxy/scripts/launch-r01.sh" --apply
```

After Desktop has relaunched, the owner opens a new external Terminal, exports the same manifest, baseline, socket, executable, and workspace variables, and runs the existing read-only verifier; its three printed PIDs become the optional identity bindings for every driver invocation.

```sh
repo=/Users/ivan/.codex/worktrees/ef29/loomhelm
manifest=/private/tmp/loomhelm-r01-codex-test/proxy-candidate-36d4fc3/manifest.env
baseline=/private/tmp/loomhelm-r01-codex-test/desktop-baseline.env
socket=/private/tmp/loomhelm-r01-codex-test/desktop-attach.sock
workspace=/private/tmp/loomhelm-r01-codex-test/desktop-attach-workspace
export LOOMHELM_R01_STAGE_MANIFEST="$manifest"
export LOOMHELM_R01_BASELINE_ENV_FILE="$baseline"
export LOOMHELM_R01_SOCKET="$socket"
export LOOMHELM_R01_DESKTOP_EXECUTABLE=/Applications/ChatGPT.app/Contents/MacOS/ChatGPT
verification="$("$repo/experiments/codex/stdio_proxy/scripts/verify-r01.sh")"
printf '%s' "$verification"
desktop_pid=$(printf '%s' "$verification" | awk -F= '$1 == "desktop_pid" {print $2}')
wrapper_pid=$(printf '%s' "$verification" | awk -F= '$1 == "wrapper_pid" {print $2}')
child_pid=$(printf '%s' "$verification" | awk -F= '$1 == "child_pid" {print $2}')
test -n "$desktop_pid" -a -n "$wrapper_pid" -a -n "$child_pid"
driver="$repo/experiments/codex/stdio_proxy/attach-driver.mjs"
marker=LOOMHELM_R01_DESKTOP_ATTACH_20261019
# Replace this example with the exact read-only tool name observed in the current codex_app catalog.
plugin_tool=read_current_thread
```

The owner must keep the Desktop UI on the disposable R01 test chat or manually reopen the exact dedicated test chat; if the UI is on another conversation, the driver must stop and the scenario must not continue.

To create a fresh dedicated thread without broad discovery, the owner runs the following command and keeps the generated mode-0600 thread file private; the driver prints only a stable reference, not the raw thread ID.

```sh
thread_file=/private/tmp/loomhelm-r01-codex-test/desktop-attach-thread.json
node "$driver" --scenario create-thread --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-create-thread.json
```

The owner should confirm in Desktop that the newly created disposable chat is the one receiving the marker-bound test turns before proceeding; an existing owner-designated R01 thread may be used only through a previously owner-created mode-0600 thread file with the same workspace and marker binding.

The remaining driver commands are bounded one-scenario runs against the same exact thread file; each writes a new 0600 evidence file and exits after the owner action or reconciliation condition is observed.

```sh
node "$driver" --scenario send --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-send.json
node "$driver" --scenario approval-accept --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-approval-accept.json
node "$driver" --scenario approval-decline --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-approval-decline.json
node "$driver" --scenario steer-interrupt --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-steer-interrupt.json
node "$driver" --scenario disconnect-reconcile --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-disconnect-reconcile.json
node "$driver" --scenario plugin-readonly --manifest "$manifest" --socket "$socket" --workspace "$workspace" --marker "$marker" --plugin-tool "$plugin_tool" --desktop-pid "$desktop_pid" --wrapper-pid "$wrapper_pid" --child-pid "$child_pid" --thread-file "$thread_file" --evidence /private/tmp/loomhelm-r01-codex-test/desktop-attach-plugin-readonly.json
```

For approval-accept and approval-decline, the driver observes the bridge copy of item/commandExecution/requestApproval but sends no first response; the owner clicks the requested decision in Desktop, after which the driver sends one late opposite duplicate and verifies that no new turn or side effect appears.

For steer-interrupt, the owner accepts the exact /bin/sleep 30 approval in Desktop and the driver sends turn/steer followed by turn/interrupt, requiring the same turn identity and interrupted completion.

For disconnect-reconcile, the owner leaves the sleep approval pending while the driver closes only its bridge socket, reconnects, reads the same thread history, and then asks the owner to decline the still-pending Desktop approval; a changed wrapper or child PID fails the evidence.

For plugin-readonly, the owner must select one harmless read-only current-thread or task metadata tool from the current Desktop codex_app catalog and pass its exact name as --plugin-tool; `read_current_thread` above is only an example placeholder and must be replaced after inspecting the current catalog. The driver requires a matching codex_app mcpToolCall item on the exact thread and turn with item/completed, status=completed, no error, and a structured result field. The owner manually handles any mcpServer/tool/call request in Desktop, the bridge never answers it, and unavailable, error, started-only, wrong-server, wrong-tool, or text-only results are explicitly inconclusive and never plugin proof.

## Exit and recovery

After the owner finishes or aborts the scenarios, the owner manually quits the entire test Desktop, waits for the exact retained wrapper and child to exit, verifies that the exact socket path is absent, and runs rollback preview; the driver never kills or signals the Desktop, wrapper, or child.

```sh
test ! -e "$socket"
"$repo/experiments/codex/stdio_proxy/scripts/rollback-r01.sh" --print
```

If the owner approves restoration, the owner runs rollback from the external Terminal with LOOMHELM_R01_OWNER_CONFIRMED=1, LOOMHELM_R01_IDLE_WINDOW_CONFIRMED=1, and LOOMHELM_R01_ALLOW_RESTART=1; rollback-r01.sh --apply restores only the four captured variables and starts the normal Desktop executable.

No Desktop acceptance may be claimed from the prepared scripts, the fixture, the isolated real-CLI evidence, a cold resume, or a failed or inconclusive plugin scenario; only a future owner-run evidence set with stable same-child, same-thread, callback-ownership, approval, interrupt, and reconnect results can change that status.
