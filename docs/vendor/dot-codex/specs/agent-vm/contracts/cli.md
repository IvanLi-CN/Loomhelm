# Agent VM command contract

The installed executable is `agent-vm` (Python 3). A session is selected from `CODEX_THREAD_ID`; absence fails before remote mutation. The client sends a versioned JSON request on stdin to one-shot control over `ssh agent-vm-host`. No credential contents belong in arguments. Local help/version do not require a VM.

## Commands

| Command | Behavior |
| - | - |
| `doctor` | Dependencies, protocol, pinned VM image, native components and CT-local capacity facts; no lease allocation or PVE storage access. |
| `version` / `help` | Local version/protocol or command help; no session or host access required. |
| `acquire [--cpu N] [--memory SIZE] [--disk SIZE]` | New VM uses supplied sizes or 2 vCPU/4 GiB/20 GiB defaults. Cache retains omitted sizes and applies explicit fields before startup, never shrinking disk. Active equal sizes reuse; differences fail with resize guidance. No implicit renewal. |
| `status` | Server time, lease state, native guest state/availability, resources, actual deadline, cache age, mappings and admission diagnostics. |
| `renew` | Add 15 minutes with a two-hour remaining cap; expired or drained requests fail. |
| `release` | End lease, revoke mappings/flows, stop; keep disk as disposable cache. |
| `destroy` | Explicitly discard the current session's VM after authorized data loss. |
| `restart` | Restart an active guest without extending deadline; explicitly renew first if less than five minutes remain. Agent and IPv4 readiness share that five-minute monotonic budget after native start. |
| `resize [--cpu N] [--memory SIZE] [--disk SIZE] [--allow-restart]` | At least one size; only disk growth. Default changes require restart: without allowance return an unapplied plan before reclaim or mutation. |
| `resize --memory SIZE --live` | Explicit native live balloon/hotplug; memory only, incompatible with CPU/disk flags or restart allowance. No automatic restart fallback; deadline unchanged. |
| `ssh-info --format json\|ssh-config` | Current root connection and verified host-key/config material; expired access fails. |
| `ssh [-- <ssh-arguments>]` | Native OpenSSH with generated strict configuration. |
| `exec -- <argv>` | Native SSH execution with arguments quoted individually and remote exit status retained. Shell syntax requires explicit `sh -lc`. |
| `sync --name NAME` | Invoke the archived synchronization helper from the current Git worktree. |
| `upload SOURCE DESTINATION` | Online native transfer to the guest; does not renew. |
| `download SOURCE DESTINATION` | Online native transfer from the guest; does not renew. |
| `export PATH` | Tar stream on stdout, diagnostics only on stderr; no guest/CT archive file. |
| `port add NAME --guest-port N [--protocol tcp\|udp] [--host-port N]` | Native NAT; default auto free-pool port. Same-name same-config is idempotent. |
| `port list` / `port remove NAME` | Inventory or exact removal with flow cleanup, without renewing/stopping guest. |
| `admin status` | Host/native component health and maintenance status. |
| `admin drain enter\|status\|exit` | Refuse new leases/extensions; active leases may retrieve/release and expire normally. |
| `admin session list` | Managed session inventory. |
| `admin reconcile [--apply]` | Dry-run by default; explicit bounded native/state reconciliation. |
| `admin gc [--apply]` | Dry-run by default; all eligible stopped caches, with no minimum idle age; explicit application rechecks eligibility. |

Flags not listed here must come from the installed `--help`, rather than invented command layouts. `sync_worktree.py --name NAME` is also independently invocable and uses only `ssh-info --format ssh-config`.

## Reclamation selection

Manual `admin gc [--apply]` selects all managed stopped caches without an effective lease and with confirmed access cleanup, regardless of idle age. Dry-run is the default; applying cleanup reacquires object locks and rechecks current generation, identity and eligibility. A resumed cache, valid lease, transitional object or unaccounted native mapping is protected. Candidate errors identify incomplete deletion rather than asserting capacity was released. The native age timer independently selects caches idle at least `cache_seconds` (default 86400); that threshold is not a retention guarantee.

Protocol 3 broadens manual selection from protocol 2's age-only behavior. Both CLI and control reject incompatible protocol requests before replay or mutation, preserving durable state and operation journals. No old request is converted or replayed under the broader semantics.

## Management response and retries

Management JSON must expose protocol version, server time, session, generation, actual state/deadline, operation identity and outcome. Acquire, restart and restart-capable resize use a 600-second local SSH management timeout; other management commands retain 240 seconds. Remote stderr is forwarded while the request is running, and stdout remains the single JSON response stream. Errors identify retryability, the actual failure phase, cleanup result and partial transitions. A transport failure must not be printed as a successful JSON response. A mutation retry must reuse its operation ID and expected generation; generations and lease expiry reject late commits, and queries must not repair/extend a lease invisibly. Exact wire field names are owned by the archived client/control protocol and must be versioned together.

Protocol 4 uses request fields `protocol`, `action`, `session_id`, and (for mutations) `generation` and `operation_id`. Management command names map to actions in the archived CLI. Mutation commands accept `--operation-id`; the client writes the original request to a protected local operation journal before sending it, so an uncertain request can be retried with the same ID. A different payload with that ID fails. The control stores pending/completed outcomes durably; a pending outcome after interruption fails as `operation_incomplete` and requires status/reconciliation rather than repeating effects.

Client and control must both use protocol 4; mismatches fail explicitly. Existing state, lease generations and operation records are retained. Old pending requests must be inspected and converged before upgrading; they are never rewritten or automatically replayed under the new protocol. Acquire resource fields are `cpu`, `memory_mib` and `disk_gib`; they use resize ranges (1–16 CPU, 512–65536 MiB, 20–4096 GiB) and the same CLI unit parsers. New creation and cache adjustment verify native disk size and guest filesystem capacity.

Capacity responses have `scope: ct-filesystem` and one local filesystem layer, measured at the configured Incus pool path. Capacity admission and reclamation use these current CT-local observations; no backing-storage probes or PVE access are required or supported.

Success envelopes contain `ok`, `protocol`, `server_time`, `action`, `session_id`, `generation`, `operation_id`, `outcome` and `result`. Replay adds freshly observed `current_state` while preserving the historical result. Only a committed explicit renewal changes the deadline; its deadline and replay record commit in one short transaction. An interrupted native timer rearm is recoverable from the recorded deadline. State summaries expose `effective_lease`, `lease_expires_at`, `inactive_since`, ports, verified resource records and any conservative `resource_reservation`. Error diagnostics are JSON on stderr with a nonzero exit. A CLI transport error includes the operation ID and never asserts whether its side effect completed.

## Resource diagnostics

`doctor.result.resources` and `status.result.admission` expose `verified`, `base`, `ratios`, `limits`, `allocated_and_reserved`, `remaining`, `ct_capacity` and `memory` (bytes: `limit_bytes`, `available_bytes`, `threshold_bytes`, with verified sources and observation time). Memory observation failures are structured `error` objects; component `ready` and `admission_ready` differ during admission refusal. Stopped caches do not count CPU/RAM; transitions use max(current,reserved) per object. A quota denial identifies `dimensions`, `requested`, `other_allocated`, `projected`, `base` and `limits`; actual pressure rejects admission without subtracting full virtual RAM. Logical reservations precede disk reclaim and native mutation.

Status exposes `native_status` and `guest_available` separately from `effective_lease`. Unexpected stops are unavailable, with unknown cause unless attributable native evidence exists; a CT-wide OOM count is not attribution. Queries do not repair or restart a guest. Native failures preserve diagnostics and observed partial results. Project aggregate CPU/RAM quota conflicts fail admission and require explicitly authorized operations, not automatic config changes.

## Live memory adjustment

Protocol 4 adds the boolean `live_memory` resize field; protocol 3 peers fail explicitly before replay or effects. Live resize requires memory only, a running guest, intact recorded/native sizes and at least three minutes remaining. A same-size request returns an unchanged plan. Growth reserves max(current,target) and uses normal allocation/CT-pressure gates. Reduction preserves the old reservation until verified success but bypasses new-demand observations, including unavailable metrics. Drain still refuses resource changes. It performs no disk reclaim, NAT changes, lease extension or guest restart.

Successful results expose `mode: live-memory`, `completed`, `native_attempts`, `verification.source: incus-live-update`, `configured_memory_mib` and unchanged `guest_boot_id`. Incus acknowledges its native balloon/hotplug operation; control verifies stored native sizes and a running responsive guest with the same boot identity before committing accounting. Linux MemTotal may stay unchanged after ballooning and is not the effective allocation measurement. Host headroom/RSS recovery and process continuity require real acceptance, not a configuration value alone.

Only a memory reduction with the exact Incus balloon-convergence timeout reporting a current size above target permits one bounded same-target completion attempt within the original operation. It waits once for 45 seconds to let a large balloon converge, rechecking identity/generation, remaining lease, drain, native rollback, guest boot identity and conservative reservation before and after that interval (105 seconds required before waiting, 60 before the final update); native configuration already equal to the target is refused because a config no-op cannot acknowledge effective memory. Accounting stays conservative until an actual native acknowledgement. `native_attempts` preserves the first error and final outcome. Growth/hotplug and other failures are not retried automatically, and there is no third attempt or polling loop.

Unsupported native growth/shrink, an unconfirmed timeout or continuity failure yields `resize_partial`, preserving the original error, completed stages and max(current,target) allocation. It does not stop an effective lease or promise rollback. Further live changes fail as `resize_incomplete`; inspect native/guest state and use explicitly allowed restarting resize or normal release for recovery. Existing operation IDs replay their recorded result rather than repeating effects.

## SSH configuration

The complete configuration uses `Host agent-vm`, root, `HostName 192.168.31.19`, the leased NAT port, explicit `IdentityFile`, `UserKnownHostsFile`, VM/generation-bound `HostKeyAlias`, `StrictHostKeyChecking yes` and `IdentitiesOnly yes`. Key material/config files are private. Renewal preserves ports; a new generation restores only SSH. Authentication refresh does not change the lease.

## Output and data

Management output is JSON; diagnostics go to stderr and slow-start observations are forwarded in real time. After native start, agent and IPv4 readiness use one shared 300-second monotonic budget, with one 120-second slow-start diagnostic boundary and at most one bounded continuation wait. Native start, disk/configuration mutation and post-check operations retain separate bounded timeouts. Native SSH/exec/transfer preserve their normal data and exit codes. Export stdout contains only tar bytes. CT and guest do not store export archives. Online files retained on the user's machine are chosen explicitly by the caller; there is no server-side artifact retention service.

## Default admission and native inventory

Doctor exposes `instances` with `verified`, `total`, `running`, `stopped`, `cached`, `other`, configured VM count `limits`, and `policy_compliant`. Status includes the same inventory under `admission.instances`. `limits.instances` and any configured `limits.virtual-machines` conflict with the managed policy; container-only restrictions are retained. New creation, cached restoration and resource growth reject a conflict before reservation or native effects. A verified memory-only live reduction can return capacity without new-demand policy checks; it never edits project policy. Existing lease queries, renewal, retrieval, release and equal-size acquire remain available.

`doctor.ready` describes component health; `admission_ready` additionally requires direct admission of the default new 2-vCPU/4096-MiB/20-GiB guest. `default_admission` contains those `requested` sizes, `request_cost_bytes`, advisory `ready`, `reasons` and `reclaim_required`. Reasons separate policy conflict, `resource_insufficient` with dimensions/request/remaining, CT `memory_pressure`, `draining`, unavailable metrics and `disk_reclaim_required`. Default disk readiness accounts for current reservations and the configured creation cost. Doctor does not reclaim anything. A disk-reclaim indication permits normal acquire to evaluate eligible caches; this observation neither guarantees request success nor blocks reuse of an effective lease.
