---
status: accepted
---

# Agent VM CPU and memory overselling

Agent VM must permit both CPU and memory overselling. The baseline control rejected creation or resize when summed guest allocations exceed its configured CPU or memory budget; the baseline topic Spec also excluded additional memory overselling. That restriction does not satisfy the owner's requirement to let multiple Agent workloads request larger guest configurations without reserving their simultaneous peaks.

The required direction is to distinguish CT-local allocatable capacity, an oversold allocation budget and observed resource pressure. A guest's configured vCPU and memory sizes do not guarantee exclusive CPU capacity or sufficient physical memory for every guest to consume its maximum simultaneously. CPU contention and memory exhaustion have different consequences and require separate admission rules.

The confirmed design replaces the topic's one-to-one CPU/memory admission rule. It supplements ADR 0025's native lifecycle architecture. Installation and observed coverage belong in the implementation companion; this decision does not establish deployment success.

## Settled boundaries

- Both CPU and memory overselling are required; retaining the current one-to-one allocation cap is not an acceptable result.
- Keep configurable aggregate allocation ceilings, initially CPU four times and memory twice the base budgets. With the current 15 vCPU and 12 GiB base budgets, the ceilings are 60 vCPU and 24 GiB. These are configurable allocation ceilings, not simultaneous physical capacity promises.
- Refuse new creation, stopped-cache restoration and growth when actual CT-local memory headroom is below `max(1 GiB, 10% of CT-visible memory capacity)`. Do not subtract the complete requested virtual memory allocation from that headroom. The pressure gate does not refuse existing-lease queries, renewal, retrieval or release. Later native OOM is possible and must be reported without proactively stopping an effective lease.
- CPU and memory allocation accounting includes admitted non-cached objects and pending transitions. Stopped caches retain their disk but consume no CPU or memory allocation budget, preserving the current control's accounting semantics.
- Add `acquire --cpu --memory --disk`. New guests use requested values and existing defaults for omitted fields. Stopped caches retain omitted fields and may change explicit fields before startup; disks only grow. For an effective lease, a differing explicit request reports the mismatch and points to `resize` without interrupting the guest. Repeated acquire never renews.
- Capacity observations remain inside the authorized CT. PVE access, topology discovery and underlying-capacity probes remain excluded.
- The native Incus and bounded one-shot control architecture remains in place. No custom persistent service, polling loop or implicit lease extension is introduced.
- Existing effective leases are not proactively stopped to admit a different request. Native exhaustion is reported as a failure, without automatic victim selection or restart.

## Enforcement and failure contract

The base budgets must remain valid against authorized CT-local capacity. Their multiplied allocation ceilings may exceed that capacity. Admission must count current allocations and pending reservations atomically; a resize must not double-count its target's old and requested configurations. Native guest CPU and memory settings remain guest limits, not simultaneous host-capacity promises.

Remove Incus project aggregate CPU and memory quotas that count stopped caches, rather than using them as an active-allocation limit. The one-shot control owns the active allocation ceiling; this does not claim a security boundary against trusted host-root access outside control. Other native limits and existing ownership checks remain applicable.

Actual memory headroom must come only from a validated CT-local view bounded by the CT's effective memory limit. Missing or contradictory measurements fail the new admission explicitly. New admission checks do not reserve the entire requested virtual memory size, estimate future guest workloads, promise OOM prevention, or poll continuously.

A denial must name its dimension and give the requested value, projected allocation, ceiling or measured headroom and threshold as applicable. Native startup or resize failure must preserve the existing lease and partial-failure contracts; it is not silently converted into a quota denial. A guest stopped unexpectedly under an effective lease must be reported on the next observation. Report OOM as the cause only when native evidence supports it; do not automatically restart or choose another live VM to terminate.

The existing lease, disk-reclamation, transfer and host-authorization contracts remain applicable. CLI and control use protocol 2 so new configuration requests cannot be silently ignored by an older peer. Existing operation records and state are retained; uncertain requests are not converted or replayed across protocols.

## Verified implementation constraints

The baseline control validated that its CPU and memory allocation budgets did not exceed CT-visible capacity before checking the admitted total. Raising configuration values alone would therefore produce `resource_budget_invalid`; physical capacity and the oversold allocation ceiling must become separate concepts.

Incus project CPU and memory quotas sum configured resources across all instances, including stopped caches, whereas control excludes stopped caches from its CPU and memory totals. A project quota equal to an active-allocation ceiling would let disposable caches consume that ceiling. The design must settle this difference instead of copying one number into both layers. See the [official project limits](https://linuxcontainers.org/incus/docs/main/reference/projects/#project-limits) and the [7.5.1 aggregate calculation](https://github.com/lxc/incus/blob/v7.5.1/internal/server/project/permissions.go#L1763).

Numeric VM vCPU allocations share scheduling capacity. Incus memory ballooning can reduce a configured guest limit, but does not establish automatic balancing under CT memory pressure. Native memory exhaustion can trigger cgroup OOM and terminate a QEMU process. Admission observations cannot guarantee that already admitted guests will never exhaust memory later. See the [VM CPU and memory options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/) and the [Linux cgroup memory interface](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

These facts were checked against source and official documentation without CT/PVE access. Observed rollout and empirical coverage are recorded in the topic implementation companion.
