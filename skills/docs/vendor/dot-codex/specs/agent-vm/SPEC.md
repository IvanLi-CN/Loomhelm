# Native Incus Agent VM

## Context and Scope

Agent code needs an isolated Linux machine with root SSH, Docker/Compose and predictable resource ownership. This topic owns the CT109 LXC + Incus VM lifecycle, its one-shot client/control contract and the two Agent Skills.

The implementation consists of a Python client, a one-shot CT control command, a source synchronization helper and native systemd units. Resident custom services, gateways, HTTP APIs, implicit keepalive, shared caches, export storage, snapshots and guaranteed recovery after lease end are outside this contract.

## Terms and Interfaces

The canonical domain language is in [CONTEXT](../../../CONTEXT.md#agent-vm). The command surface is [the CLI contract](contracts/cli.md). `CODEX_THREAD_ID` selects resource ownership; it is not authentication. The same trusted computer has management access for daily and operations tasks. Skills and task authorization separate those responsibilities.

## Requirements

### REQ-AGENT-VM-001 — Execution boundary

The system MUST use the existing host SSH 22 to run bounded control actions with JSON on stdin. Production custom executable entrypoints MUST be limited to the local client, CT control and synchronization helper. It MUST NOT add a resident Broker, gateway, API, poll loop, extra host sshd or automatic keepalive. Diagnostics MUST go to stderr and be forwarded in real time by the client; management output MUST remain JSON with protocol identity, server time and actual state. Missing session identity or incompatible protocol MUST fail clearly. Acquire, restart and restart-capable resize management requests MUST allow 600 seconds of local transport time; other management requests retain 240 seconds. A transport timeout or unknown result MUST identify the operation ID without re-requesting the mutation.

### REQ-AGENT-VM-002 — Ownership and idempotence

Each session MUST occupy at most one VM slot, including preparing, closing, deleting and cached states. Mutations MUST use operation identity, lease generation, atomic durable records and coordinated short global/object locks. Retried requests MUST NOT duplicate a lease extension, VM or port. Startup, stop and deletion waits MUST NOT hold the global lock. After native start completes, agent and IPv4 readiness MUST share one monotonic-clock 300-second budget; a normal readiness timeout MAY continue one bounded native wait using the remaining budget, while explicit native failure or a stopped guest MUST fail promptly. Each native wait transport timeout MUST be no greater than its integer remaining budget, and bounded diagnostic sources MUST charge their time against the same deadline. At 120 seconds without readiness, control MUST emit one bounded slow-start diagnosis and continue the same startup without restarting it. Lease expiry or generation change MUST reject late readiness and commit results, and a stale late result MUST NOT reopen NAT. Credentials MUST remain outside source, argv contents and ordinary logs.

### REQ-AGENT-VM-003 — Explicit leases

The default guest MUST be Debian 13 with 2 vCPU, 4 GiB RAM and a 20 GiB virtual disk. Acquire MUST accept explicit CPU, memory and disk requests. Omitted fields MUST use defaults for a new guest and retain verified sizes for a stopped cache. A differing explicit request on an effective lease MUST report the mismatch and require explicit resize rather than interrupting the guest. Initial leases MUST last 30 minutes; each explicit renewal MUST add 15 minutes up to a remaining window of two hours. Repeated acquire, queries, SSH, execution and transfers MUST NOT renew. Renewal at or after expiry MUST fail. A new lease MUST have a new generation; reuse of a stopped cache MUST NOT promise recovery and MUST restore only automatic SSH.

### REQ-AGENT-VM-004 — Access and native NAT

SSH MUST use guest root and trusted host-key verification through native Incus proxy NAT, bound only to `192.168.31.19`. The Incus project MUST explicitly allow managed proxy devices (`restricted.devices.proxy=allow`); admission MUST fail closed when that setting is absent or different. Project ports MUST support TCP/UDP, automatic allocation and explicit free ports in the configured pool (initially 20000–29999). Allocation MUST inspect listening sockets, Incus proxies, network forwards, reservations and ephemeral ranges. The guest MUST have a fixed private IP and verified network isolation. Renewal MUST preserve mappings. Removing a mapping MUST remove its exact conntrack flows. SSH configuration MUST contain the leased port, identity and trusted host-key material; it MUST NOT disable checking or use a gateway/ProxyJump. Guest SSH filesystem access MUST NOT be constrained by the helper's workspace boundary.

### REQ-AGENT-VM-005 — Expiry and lazy release

Persistent native timers MUST recheck the current generation and deadline. Expiry or release MUST remove all managed NAT mappings, delete only their precise conntrack flows and force-stop the VM, continuing stop attempts after cleanup errors. A slot or port MUST NOT be freed before cleanup is confirmed. Failures MUST retain a non-active transitional record for bounded retry. VMs MUST be non-ephemeral with autostart disabled; boot reconciliation MUST fail closed. Under normal load, access revocation MUST complete within two seconds and VM stop within ten seconds; client disconnect detection MUST be measured separately.

### REQ-AGENT-VM-006 — Cache reclamation

Release MUST normally retain a stopped disk as a disposable cache, without a minimum retention period. Once a managed cache has no effective lease and native stop and access cleanup are confirmed, it MUST be eligible for reclamation regardless of age. Eligibility MUST NOT imply immediate deletion. Cache age MUST start at the most recent lease end, including early release, and MUST NOT change on duplicate release, status or retry. A native 15-minute age sweep MUST reclaim managed stopped caches idle for at least 24 hours; this threshold MUST NOT be treated as a retention guarantee or an eligibility floor for other cleanup callers. Allocation, restore or resize under capacity pressure MAY reclaim any session's eligible stopped expired cache, oldest first and only until sufficient capacity exists. The system MUST NOT reclaim a valid lease, transitional object, current resize target or unknown resource, and MUST NOT run periodic pressure reclamation of young caches. Explicit destroy MUST require task authorization to discard that VM.

Manual garbage collection MUST select all eligible stopped caches without a minimum idle age and MUST be dry-run by default. Deletion MUST require explicit application and a fresh object-locked eligibility check, protecting any cache that resumed after preview. The age timer MUST select age-based cleanup explicitly rather than inherit manual selection defaults. Broader destructive selection MUST use matching versioned CLI/control semantics; old-protocol requests MUST NOT be silently widened, rewritten or replayed under the new semantics. Existing state, lease generations and operation records MUST be preserved.

### REQ-AGENT-VM-007 — Capacity and resizing

Sparse dir disks MAY be oversold using actual allocation, request cost and reachable watermarks: initial low `max(10 GiB, 15%)`, target `max(20 GiB, 25%)`, plus request cost. Admission MUST measure only the authorized CT-local filesystem containing the Incus dir pool. It MUST NOT query PVE backing capacity, discover its storage topology or execute external storage probes. Unavailable or invalid CT-local metrics MUST reject new admission with the missing metric named. Capacity pressure MUST NOT stop a valid lease; insufficient capacity after reclaim MUST reject the new request. Actual ENOSPC/I/O errors MUST be reported. Resize MUST name a resource, MUST NOT renew, and MUST only grow disk. Memory-only resize MAY explicitly use native Incus live balloon/hotplug with no automatic restart fallback. It MUST require a running owned guest, unchanged boot identity and successful native live-update acknowledgement before committing lower accounting; guest MemTotal alone MUST NOT be treated as effective balloon allocation. Live growth MUST retain normal allocation and actual-pressure admission, while live reduction MUST NOT reclaim disks or alter NAT, deadlines or cache state. Only a memory reduction with the exact native balloon-convergence timeout reporting a current size still above the target MAY trigger one same-target completion attempt inside the original operation, after one fixed 45-second wait, with ownership, generation, lease window, drain, rolled-back configuration, boot continuity and the unchanged conservative reservation rechecked before and after the wait. At least 105 seconds MUST remain before waiting and 60 seconds before the final native attempt; the live request still requires three minutes initially. Growth MUST NOT use this retry because native hotplug effects may be repeated. The system MUST keep the full reservation, record both outcomes and never poll or attempt a third native update. A native configuration already equal to the target MUST NOT be accepted as evidence through a no-op retry. Unsupported, otherwise timed-out or still partially verified live updates MUST preserve conservative reservations and the original error without automatically stopping an effective lease; subsequent live requests MUST refuse uncertain reservations until explicit recovery or release. CPU/disk changes and the default resize path MUST retain the explicit restart contract. If restart is required without explicit allowance, it MUST report a plan without mutating. Virtual block capacity and guest filesystem growth MUST be verified separately for creation, cache adjustment and resize, with partial failures reported accurately.

CPU and memory MUST support separate configurable overselling ratios, initially four for each, applied to verified CT-local base budgets with ceilings rounded down. The initial base budgets are 15 vCPU and 12288 MiB, yielding allocation ceilings of 60 vCPU and 49152 MiB. Stopped caches MUST consume no CPU/memory allocation budget; other occupied states and conservative reservations MUST be counted atomically. Resize MUST count its target only once using the larger of current and requested sizes. An explicit memory-only live reduction MUST keep the old allocation until native completion and guest continuity are verified; it MUST remain available under memory pressure or unavailable admission metrics because it adds no resource demand. Known allocation or memory-pressure refusals MUST precede cache deletion or guest interruption. Logical reservations MUST precede disk reclamation; failures MUST release only safely reversible reservations and retain partial native changes accurately. Incus project aggregate CPU/memory quotas that count stopped caches MUST be removed by authorized deployment; daily control MUST reject conflicting quotas rather than modifying them.

Actual memory observations MUST remain inside the CT. A finite CT root cgroup memory limit MUST bound headroom derived from `memory.max - memory.current + inactive_file`, clamped to its limit. A verified LXCfs meminfo view, when present, MUST further bound capacity and available memory. An unlimited cgroup view MUST require verified LXCfs `MemTotal`/`MemAvailable`; missing or invalid metrics MUST reject new demand explicitly. Headroom below `max(1 GiB, 10% of effective visible memory capacity)` MUST refuse creation, restoration and growth without reserving the full requested virtual memory size. Queries, renewal, retrieval and release of an existing lease MUST remain available. Overselling MUST NOT promise simultaneous peak capacity or automatic balloon balancing. Unexpected native guest stops MUST be reported on observation without automatic restart; OOM MUST be attributed only from object-specific native evidence.

Native VM resource changes, including disk growth, MUST use an explicitly allowed restart and otherwise return an unapplied plan before reclamation or mutation. Restart and restart-capable resize MUST require at least the shared 300-second readiness window remaining, while live memory adjustment retains its separate bounded window; insufficient time MUST produce an explicit denial without renewing. Native start, native disk/configuration changes and post-checks MUST retain their own bounded timeouts, so the readiness budget is not a total acquire guarantee. Partial changes MUST retain conservative reservations and identify the actual failure phase and confirmed cleanup result until native resource sizes and guest growth are verified. Explicitly requesting an unchanged disk size MUST still verify or complete guest filesystem growth, allowing recovery from a previously reported partial expansion. Slow-start diagnostics MUST record readiness stage timings, CT-visible CPU PSI, the target QEMU process runtime/runqueue wait, native status and a bounded redacted startup-log summary through protected audit data; native log retrieval MUST retain no more than 8192 bytes before redaction and mark truncation, and redaction MUST cover complete or truncated private-key blocks, quoted or unquoted secret assignments, bearer credentials, the conservative diagnostic payload suffix following any password-bearing `sshpass` flag, including quoting, concatenation, substitutions and continuations, and credential-bearing URLs for any URI scheme. Every diagnostic Incus query and log command MUST use a bounded subprocess path. Bounded diagnostic subprocesses MUST run in a dedicated process group and terminate/reap that group on timeout, with final liveness confirmation even after direct group signaling succeeds and a bounded member fallback when signaling fails; if group cleanup cannot be confirmed, diagnostics MUST report only its safe cleanup state without exposing raw command output. Diagnostic collection failures MUST never mask the original operation error or renew the lease. Native starts and managed proxy mutations MUST serialize with lease cleanup under a per-session native lock, and each late native effect MUST recheck its current generation and effective lease before applying. Final readiness, restart and mapping commits MUST re-read the durable task under the global lock and reject a changed generation, closing state or expired lease before recording success.

The managed Incus project MUST NOT impose a global instance-count ceiling that includes stopped caches. Explicitly authorized deployment MUST remove the conflicting ceiling while preserving unrelated restrictions and per-VM limits. Daily admission MUST detect conflicting native count limits before resource reservations, reclamation or guest mutation, and MUST NOT silently modify project policy. Per-session uniqueness and CPU/RAM, actual-memory-pressure and disk admission MUST remain enforced. Removal of a count limit MUST NOT enlarge the allocation budgets or imply that a resource request fits.

Read-only doctor MUST distinguish component health from default-new-request admission. Its admission advice MUST evaluate default resource sizes, allocation remaining, verified CT pressure, drain, native count policy, disk creation cost and existing reservations, reporting blocking reasons and required disk reclamation. It MUST NOT reserve or reclaim resources. Actual requests MUST independently execute their own atomic admission, and valid-lease reuse MUST NOT depend on default-new-request readiness.

### REQ-AGENT-VM-008 — Code synchronization and retrieval

Synchronization MUST select tracked and unignored files using a NUL list, exclude `.git`, skip deleted sources and reject submodules before remote writes. It MUST accept a safe single-segment name and write only `/workspace/worktrees/<name>/src`, verifying canonical parents, symlinks and helper ownership. It MUST stage in the same parent, lock concurrent commits, validate transfer and atomically replace only helper-owned source. Before commit, failures MUST preserve the prior source and adjacent results. A lost commit acknowledgement MUST be reported as unverified with recovery materials retained, without blind rollback. Temporary SSH configuration MUST be 0600 and removed on exit. The helper MUST NOT acquire, renew or release. Export MUST stream tar online and MUST NOT write an archive on CT or guest.

### REQ-AGENT-VM-009 — Skills and operations

`agent-vm` MUST route daily Linux, Docker/Compose and heavy validation and own the Agent's retention and voluntary-release procedure; `agent-vm-ops` MUST route explicitly authorized infrastructure work. Engineering flows MUST call the daily Skill's policy at actual task closure and after merge, without maintaining another copy of the operating procedure.

After a large-memory phase ends, the Agent MUST explicitly reduce its own VM memory to a size adequate for expected remaining work when current/background workloads safely permit it, preserving the VM disk and build cache. It MUST inspect actual workload needs and the live-adjustment result rather than assume automatic balloon reclamation or shrink another session.

The Agent MUST retain its session VM while the current task is likely to use it again, including build-cache reuse. Validation completion, CI/review/owner-feedback waits, PR publication and readiness handoffs MUST NOT alone trigger voluntary release. While actively progressing or tracking that task, the Agent MAY explicitly renew for expected follow-up use even when no guest command is running, within the existing lease limits and drain restrictions. Returning control to the owner or interruption MUST NOT imply continuing renewal. Independent background keepalive MUST NOT be introduced; expiry MUST remain the fallback rather than the normal closure procedure.

Voluntary closure MUST follow PR merge when no further VM work is expected, completion of a non-PR task without expected VM follow-up, cancellation or a confirmed end to further VM use. Post-merge VM verification MUST finish before closure; remote CI/release tracking without further VM use MUST continue independently of VM release. Closure MUST retrieve required data online, finish guest work and use release, then verify ended lease, completed access cleanup and stopped/cache state. Failed cleanup or an already-expired lease MUST be reported from observed state rather than presented as successful voluntary release. The Agent MUST NOT acquire or renew merely to manufacture a closure result. A retention handoff MUST state the expected follow-up use and server deadline without promising future renewal. Release MUST preserve the existing disposable-cache semantics, and destroy MUST still require explicit discard authorization.

Operations MUST provide health, drain, inventory, reconciliation and garbage collection with dry-run defaults. Planned drain MUST refuse new leases and extensions while permitting retrieval and release until existing leases end and cleanup is confirmed. Forced interruption MUST require separate explicit authorization. Images MUST include OpenSSH, Python, rsync and Docker/Compose and be pinned after validation. All active routes MUST use the new Skills while preserving explicit approval for local Docker.

### REQ-AGENT-VM-010 — Source and deployment

Archived candidate source MUST be the only implementation truth after draft import. Deployment MUST install that exact revision/checksums, retain the existing SSH management alias and report component versions, storage facts and inspectable validation. CT Arch packages MUST use a complete upgrade transaction. Codex runtime home, unrelated resources and revocation backups MUST remain untouched. Fault validation MUST use precisely owned VMs/isolated pools, without production clock changes, full production disks or global conntrack flushes.

## Verification

### VER-AGENT-VM-001

- covers: `REQ-AGENT-VM-001`, `REQ-AGENT-VM-002`, `REQ-AGENT-VM-003`
- Method: client/control black-box fixtures, crash/retry and simultaneous-request tests.
- Pass condition: explicit failures and stable identity; only renewal changes an active deadline; stdout/stderr separation; no duplicate resources or resident custom process.

### VER-AGENT-VM-002

- covers: `REQ-AGENT-VM-004`, `REQ-AGENT-VM-005`
- Method: real TCP/UDP NAT, conflict and network-isolation observations; short isolated leases with SSH/ControlMaster/background processes, stale timers and interrupted cleanup.
- Pass condition: trusted native root SSH, precise mapping/flow withdrawal, expired access denied, cleanup latency targets and no damage to newer generations or other VMs.

### VER-AGENT-VM-003

- covers: `REQ-AGENT-VM-006`, `REQ-AGENT-VM-007`
- Method: controlled time/admission fixtures, concurrent allocation tests and isolated storage, sparse allocation, oversold startup, reclaim and resize experiments.
- Pass condition: stable cache age with no minimum retention floor, oldest eligible cross-session reclamation stops when enough; manual GC previews and explicitly applies cleanup of young eligible caches while the timer remains age-filtered; incompatible destructive semantics fail without widening old requests; active/unknown objects and concurrently resumed caches protected; stopped caches cannot exhaust a global native instance-count ceiling; conflicting count policy is reported before destructive effects; CT-only validated metrics; oversold ceilings and pressure refusals precede destructive effects; cache-free CPU/RAM accounting; disk/guest growth and native failures reported without peak-capacity or OOM-prevention claims; explicit live memory reduction succeeds under pressure without reboot, with preserved processes, mappings and deadlines and observed host-memory recovery; live growth retains admission and uncertain native results retain conservative accounting.

### VER-AGENT-VM-004

- covers: `REQ-AGENT-VM-008`
- Method: Git file fixtures, SSH/rsync substitutes, concurrent and failed commits; real candidate synchronization and online retrieval.
- Pass condition: special names preserved, path escape refused, original source/results retained on precommit failure, uncertain commit reported and temporary configs cleaned; tar exclusively streamed.

### VER-AGENT-VM-005

- covers: `REQ-AGENT-VM-009`, `REQ-AGENT-VM-010`
- Method: migration/index/Skill checks, deployment revision verification and real use through the candidate Skill, plus drain and host SSH checks.
- Pass condition: no retired active route, local Docker authorization retained, separate task responsibilities, exact source installed and no runtime-home or unrelated mutation.

### VER-AGENT-VM-006

- covers: `REQ-AGENT-VM-003`, `REQ-AGENT-VM-009`
- Method: candidate instruction and engineering-flow inspection against retention/closure scenarios, Skill/Spec checks and source-delta inspection. This checks the instruction contract, not live model compliance or a new lifecycle deployment.
- Pass condition: expected follow-up and cache reuse retain the VM across validation/readiness/wait boundaries; active task tracking permits explicit bounded renewal without background keepalive; merged/no-follow-up, completed non-PR and cancelled tasks retrieve then release; post-merge VM work delays closure while remote-only tracking continues after release; failed/expired closure is reported accurately without reacquisition or discard authority; the retention procedure adds no implicit lifecycle mutation.

## Related ADRs

- [Native Incus Agent VM lifecycle](../../adr/0025-native-incus-agent-vm-lifecycle.md)
- [Agent VM CPU and memory overselling](../../adr/0026-agent-vm-cpu-memory-overselling.md)

## References

- [Implementation coverage](IMPLEMENTATION.md)
- [Replacement history](HISTORY.md)
- [Incus proxy NAT](https://linuxcontainers.org/incus/docs/main/reference/devices_proxy/)
- [Incus live VM memory limits](https://linuxcontainers.org/incus/docs/main/reference/instance_options/#memory-limits-in-virtual-machines)
