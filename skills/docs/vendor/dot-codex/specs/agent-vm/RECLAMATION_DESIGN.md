# Agent VM cache reclamation and instance admission

This accepted design concerns the existing CT109 native Incus implementation. Its requirements and manual-GC selection policy are settled; no deployment or implementation completion is implied.

## Requirements and decisions

- Each session keeps at most one managed VM, including its transition and cached states.
- An effective lease remains protected. An unexpectedly stopped guest with an effective lease is not a reclaimable cache.
- Expiry or release ends access and stops the guest. Once native access cleanup and stop are confirmed, its managed cache is immediately eligible for reclamation. There is no minimum retention time or promise of recovery.
- Eligibility does not require immediate deletion. Release retains a disposable cache for possible reuse; requests reclaim eligible caches only when needed. The native 15-minute age sweep selects caches idle for at least 24 hours, which is a cleanup trigger rather than a retention guarantee.
- Manual `admin gc` selects all eligible stopped caches regardless of age, with dry-run as the default and explicit application required for deletion. Its selection policy is separate from the age timer.
- Remove the `agents` project's global instance-count ceiling. Do not replace the eight-instance limit with another arbitrary instance-count limit or introduce instance-slot reclamation machinery.
- Keep the accepted CPU/RAM allocation ceilings, CT memory-pressure admission, disk admission, per-VM resource limits and unrelated native restrictions. Stopped caches consume no CPU/RAM allocation budget but retain real disk occupancy.
- No new resident service, polling loop, automatic renewal, PVE access or forced interruption of another effective lease is authorized by this design.

## Observed failure

Read-only observations on 2026-10-05 found `limits.instances=8`, eight native instances (two running and six stopped caches), and durable failures containing `Reached maximum number of instances in project "agents"`. Disk reclamation returned without deleting caches when disk headroom was sufficient; native creation then hit the independent count ceiling.

At that observation the two running guests also consumed all 24576 MiB of the accepted RAM allocation ceiling. Removing the count ceiling does not make memory admission unlimited or guarantee that another creation will succeed.

At diagnosis, installed protocol 2 had no instance-limit policy check. Its manual `admin gc` and age timer shared the same 24-hour selection filter. Its `doctor.admission_ready` did not check exhausted allocation totals or instance-count configuration, so a true value is not a promise that a new VM fits.

## Design

### Native admission

An explicitly authorized deployment removes only `limits.instances` from `agents`, preserving other project/profile restrictions and all state. The operation neither deletes caches nor stops guests. Do not enlarge CPU/RAM ceilings as a side effect.

Doctor and mutating admission inspect native project configuration. A finite instance-count ceiling conflicting with the accepted policy produces a structured configuration error before any reservation, reclamation, port allocation or guest mutation. Daily requests never silently change the native project. Check both general and VM-specific count restrictions if exposed by the installed Incus version; validate native configuration keys before relying on them.

An absent count ceiling is policy compliance, not evidence of capacity. Admission continues to reserve CPU/RAM atomically, evaluate actual CT pressure, reclaim disk only if needed, reserve native resources, and create or restore the guest. Cached restoration does not acquire an additional session slot. Disk reclamation remains oldest-first and stops when its existing capacity policy is satisfied.

### Cleanup selection and execution

Separate eligibility from selection. A shared eligibility check requires the current managed identity, stopped cache state, no effective deadline, stopped native guest and no remaining managed mappings. Unknown, transitional and effective-lease objects remain excluded regardless of native power state or elapsed time.

Selection has three callers:

| Caller | Selection | Minimum age |
| - | - | - |
| Request-triggered disk reclaim | Oldest eligible caches until sufficient capacity | None |
| Native age timer | Eligible caches at or beyond the configured idle threshold | 24 hours by default |
| Manual `admin gc` | All eligible stopped caches; dry-run unless explicitly applied | None |

Manual GC remains dry-run by default. Applying cleanup reacquires each object's lock and rechecks current eligibility and generation before deletion; a cache resumed after the preview must survive. Do not hold the global lock while waiting for native deletion. Confirm disappearance before clearing durable ownership. Failed deletion retains an accurate transitional/error record for bounded reconciliation; it must not report successful capacity release.

The age timer must explicitly select age-based cleanup rather than inherit manual defaults. Duplicate release, retries and queries do not restart cache age. An expired active object still in access cleanup is not deletable until that cleanup is confirmed.

### Diagnostics and protocol

Keep component health distinct from policy compliance and request admission. Expose native instance inventory and count restrictions, running versus stopped-cache totals, allocation remaining and concrete blocking reasons. Describe any aggregate readiness field precisely: a generic healthy flag is not approval for an arbitrary resource request. Admission errors retain requested sizes, projected allocation and actual remaining capacity.

Do not infer OOM from a stopped guest or shared CT counters. Do not hide a resource denial behind the removed count ceiling. The broader manual-GC selection requires a versioned CLI/control contract so an old client cannot silently request a broader destructive operation; preserve existing state, lease generations and operation journals rather than resetting or rewriting them. Requests recorded under the old protocol must not be rewritten or automatically replayed under the new semantics.

### Documentation and rollout

Update the existing Spec, CLI contract, both Skills, deployment reference and implementation coverage to distinguish reclaim eligibility, selection and completed deletion. Keep the canonical glossary free of implementation instructions. The existing native-lifecycle ADR owns the no-retention-guarantee boundary; this correction does not need a new architecture or backend.

When implementation is separately authorized, the candidate worktree remains the sole source writer. The existing deployment conversation installs matching archived versions and reports exact native project differences and checksums. Existing maintenance/drain rules govern an executable or protocol upgrade. A configuration-only removal must not be described as a VM cleanup or a CPU/RAM policy change.

## Acceptance

1. More than eight native instances, including stopped caches, do not fail solely because of an eight-instance ceiling; per-session uniqueness and normal resource admission still apply.
2. A just-ended, fully stopped and cleaned cache is eligible immediately. A guest stopped unexpectedly during an effective lease is protected.
3. Disk sufficiency does not cause needless cache deletion. Disk pressure can reclaim a young eligible cache, oldest-first, stopping when enough capacity exists.
4. Manual GC preview includes eligible caches younger than 24 hours and deletes nothing. Explicit application can delete those caches after fresh eligibility checks; the age timer independently selects only caches at least 24 hours old.
5. Concurrent resume or renewal defeats stale cleanup intent; deletion failures and interrupted access cleanup remain accurately reported and do not release ownership early.
6. Native configuration conflicts and exhausted RAM allocation produce distinct diagnostics. Component health cannot be mistaken for approval of a new request.
7. Versioned destructive semantics reject incompatible peers while preserving database and journal history. No resident custom process, PVE probe or unrelated resource mutation is introduced.

Real observations use precisely owned temporary sessions and isolated configuration. Do not fill production memory or disks, stop other effective leases, reset server time or flush conntrack globally.
