---
title: Bind private Docker audits to a runtime snapshot
module: xp-infra
problem_type: bug
component: audit-runtime-selection
tags:
  - audit
  - ddns
  - docker
  - private-network
  - vless
status: active
related_specs: []
symptoms:
  - An approved private Docker node is rejected as an unsafe public health target.
  - A VLESS loopback audit could independently select a different runtime than the basic audit.
  - A disabled DDNS policy passes while its effective runtime configuration is still enabled and degraded.
root_cause: Public-target policy and local runtime identity were coupled, the second probe lacked a bound runtime snapshot, and DDNS configuration intent was collapsed into its health result.
resolution_type: guardrail
---

# Bind private Docker audits to a runtime snapshot

## Context

`xp-infra audit` supports an explicitly approved private Docker node whose control-plane hostname resolves to a private address. That exception removes only the operator-side public ingress probes; local health, reconciliation, and cluster-role checks remain required.

## Symptoms

- A normal private deployment is rejected because its hostname is not publicly routable.
- A follow-up VLESS loopback probe can inspect a different container or change its access path after the basic probe has established topology.
- A private node with a disabled DDNS policy appears compliant while a degraded but enabled DDNS supervisor remains active.

## Root Cause

The audit must distinguish a public target policy decision from local runtime identity. Re-enumerating Docker during a second probe makes that identity ambiguous if the container changes or the inventory is only partially observed. Likewise, an effective DDNS enablement value and a successful DDNS reconciliation are different facts; deriving both from one health boolean hides configuration drift when the enabled service is degraded.

## Resolution

- Keep public-target validation strict by default. A private policy skips only the public health and VLESS ingress probes when its checked-in override is exactly `direct_docker: true`, `cloudflare_tunnel: false`, and `managed_default_vless: false`, and the basic probe reports container mode.
- Have the basic probe emit `host` or `container` runtime mode. For a container, validate and retain its exact 64-character ID, start time, and the unique readable Xray PID plus `/proc` start time. Require both the kernel-resolved `/proc/<pid>/exe` link and argv[0] to identify Xray; neither identity alone is sufficient. Read executable target, command line, and start time before and after the candidate observation; reject unreadable, changed, ambiguous, or partial process evidence.
- Pass that snapshot through a strict local parser to the VLESS loopback probe. Host mode requires `sudo -n` access to the host environment, cannot fall back to Docker, and binds the request to the recorded Xray PID and `/proc` start time. Container mode inspects only the recorded ID and must match its ID, running state, start time, and recorded Xray PID/start-time token both before and after `docker exec`.
- Clear alternate Docker endpoint, context, and client-config variables when an approved direct or privileged Docker path is used, and select the local default context.
- Collect public Xray listener inventory only when the policy requires a managed VLESS endpoint. A private Docker exception still proves the Xray runtime identity, local health, reconciliation, and cluster role, but does not require optional listener tooling such as `ss` inside the single-image runtime.
- Treat a missing host environment as a container prerequisite only when its absence is observable through a readable, searchable parent. An unreadable `/etc/xp/xp.env` or parent directory fails closed rather than selecting a Docker container.
- Recheck host-environment absence immediately before and after every direct Docker VLESS request, so a host-managed environment appearing between the basic and VLESS probes cannot preserve the private exception. A dangling environment link or an unobservable ancestor is ambiguous and fails closed; it is never treated as an absent host topology.
- When host Xray is reported as service-managed, revalidate the service-manager ownership after capturing its PID/start time and again before emitting the snapshot; a stable process that is no longer the managed service is not valid.
- Treat optional runtime state the same way: only a readable parent may prove that a state file is absent. A permission failure never becomes an empty managed-endpoint state and therefore cannot activate the private exception.
- Reject malformed Docker inventory rows and bound all runtime snapshot and VLESS helper Docker output before it reaches the local parser. A nonzero runtime read or probe exit status never contributes partial output.

## Guardrails / Reuse Notes

- `direct_docker: true` is a per-node, owner-approved exception, not a global fallback for failed `sudo` access. It does not by itself authorize a private public-ingress bypass.
- Never treat a private DNS result as permission to relax local readiness, cluster synchronization, or runtime identity checks.
- Never accept multiple matching Xray processes, an unreadable process entry, a forged argv[0], or a reused host/container PID without a stable `/proc` executable, command-line, and start-time snapshot.
- Do not re-run `docker ps` in the VLESS helper. A basic/VLESS pair must refer to the same verified runtime instance.
- The private exception is only valid through a checked-in owner-approved node policy; ordinary nodes retain public target validation.
- Emit DDNS enablement separately from DDNS health. An enabled policy requires both values to be true; a disabled policy requires the effective enablement to be false. Accept only explicit boolean enablement input, so an unreadable or malformed value is a failed audit. A failed enabled supervisor is never evidence that DDNS is disabled.

## References

- [agent-toolkit `xp-infra` Skill](https://github.com/IvanLi-CN/agent-toolkit/tree/main/skills/xp-infra)
- [agent-toolkit `xp-infra` runbook](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/references/runbook.md)
- [agent-toolkit `xp-infra` helper](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/scripts/xp-infra)
- [agent-toolkit local audit parser](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/scripts/xp-infra-audit-local)
- [agent-toolkit remote audit probe](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/scripts/xp-infra-audit-remote)
- [agent-toolkit VLESS audit probe](https://github.com/IvanLi-CN/agent-toolkit/blob/main/skills/xp-infra/scripts/xp-infra-audit-vless-remote)
