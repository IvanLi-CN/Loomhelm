# Agent VM history

- Memory exhaustion exposed both a 24-GiB logical ceiling and high QEMU resident memory despite free guest pages. The accepted correction adds explicit native live balloon/hotplug without a restart fallback, teaches voluntary downsize after high-memory phases and sets the configurable RAM ratio to 4 (48-GiB ceiling over the unchanged 12-GiB base). Actual CT pressure admission remains enforced for growth; native/guest continuity and partial outcomes remain inspectable. Protocol 4 fails older peers before effects while preserving state/journals. This uses the existing native lifecycle and configurable-overselling decisions.

- Initial live testing exposed Incus 7.5.1's five-second balloon confirmation window: both 2-to-1-GiB and 4-to-2-GiB attempts timed out while guest memory changed without reboot. The errors remain inspectable rather than counted as success. The correction allows one guarded same-target completion attempt for a shrinking balloon still above target within the original operation, preserving both native outcomes and conservative allocation until acknowledgement; growth/hotplug and other uncertain updates remain partial. A larger 12-to-4-GiB test then timed out both immediate attempts while the guest subsequently converged, so the single completion now follows one fixed 45-second wait with all guards checked again; the initial failures remain evidence rather than passing results. The corrected archived control completed an independently observed 12-to-4-to-12-GiB run and direct CLI/cache use; implementation evidence distinguishes native acknowledgement, logical allocation and observed resident memory.

- The retention clarification separates actual task closure from validation, review/CI waits and readiness handoffs. Expected follow-up, including build-cache reuse, keeps the session VM under an effective lease; an actively progressing Agent may explicitly renew within existing limits. PR merge without further VM work, non-PR completion and cancellation trigger normal closure. The accepted [design background](RETENTION-DESIGN.md) now points to the normative Spec and operating Skill; this instruction change does not alter protocol 3 or native expiry/cache semantics.

- The instance-count incident exposed an eight-instance project quota counting stopped caches, while manual GC used the age timer's 24-hour filter. The accepted correction removes the native count ceiling, separates immediate cache eligibility from age selection and upgrades destructive management semantics to protocol 3. CPU/RAM ceilings and valid-lease protection remain unchanged; protocol 3 installation and isolated/direct acceptance passed and are tracked in the implementation companion.

- ADR 0026 supplements the native architecture with separate base budgets and CPU/RAM oversold allocation ceilings, CT-only memory pressure admission and configurable acquire. Protocol 2 retains existing durable state and operation journals; uncertain protocol-1 requests require inspection rather than automatic conversion or replay. Current rollout and acceptance belong to the implementation companion.
- Protocol 2 was installed from `8b6a376d` after natural drain convergence, with only aggregate Incus CPU/RAM quotas removed. Direct 8-CPU/12-GiB acquire and 4-CPU/8-GiB resize passed; isolated 24-CPU/30-GiB idle startup exceeded the CT-visible capacity under an explicitly separate RAM test ratio. That rollout retained its accepted 60-CPU/24-GiB ceiling.

- Implementation delivery: [PR #159](https://github.com/IvanLi-CN/dot-codex/pull/159). Direct VM use and isolated lifecycle/reclamation observations are recorded in the implementation companion; formal review and delivery state belong to the live candidate evidence. Native preflight exposed and corrected the raw Incus query project-flag incompatibility.
- Actual VM use corrected native agent-readiness waiting, older-Python source hashing and restart-required disk visibility. A real interruption before expiry-timer creation exposed a missing-unit reconciliation defect; exact native absence proof now allows recovery without manually rebuilding a timer. The corrected source was installed and the affected recovery/expiry scenarios rerun.
- Native NAT preflight found the restricted `agents` project had no explicit proxy-device allowance. The deployment owner changed only `restricted.devices.proxy` to `allow`; candidate control now checks that setting before allocation and refuses to proceed when it is absent or blocked.
- Capacity admission is confined to the authorized CT filesystem. The earlier external storage probe requirement was removed from source, deployment configuration and operating instructions; no PVE storage evidence is part of acceptance.

## Lifecycle / Compatibility

This topic supersedes the shared host execution contract in `shared-testbox-heavy-validation`. That directory is retained for historical context and supplies no current operating entrypoint. There is no compatibility fallback.

## Replacements / Background

ADR 0025 replaces ADR 0015 with per-session Incus guests, explicit leases, lazy stopped-disk caching and native timer reclamation. An earlier unmerged Broker/gateway candidate was withdrawn; its source and acceptance are not inherited. The implementation starts from remote main at `7f27d636bf059de37abf61eadd8c9cf645d5048d`. The native decision uses 0025 because upstream assigned 0024 to release policy during implementation.

## References

- [Requirements](SPEC.md)
- [Implementation](IMPLEMENTATION.md)
- [Historical contract](../shared-testbox-heavy-validation/SPEC.md)
