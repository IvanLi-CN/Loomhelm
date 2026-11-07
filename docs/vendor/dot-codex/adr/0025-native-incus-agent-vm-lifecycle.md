---
status: accepted
---

# Native Incus Agent VM lifecycle

Agent execution uses one Incus VM per Codex session inside CT109, with root SSH through native proxy NAT and explicit leases. The trusted computer uses its existing host SSH management access for both daily and operations commands; Skills and task authorization define their boundary, rather than claiming separate Agent credentials.

Lifecycle enforcement uses one-shot control actions and persistent native systemd timers. Lease end closes NAT and exact conntrack flows before stopping the guest, then retains its disk as a disposable stopped cache. Age-based cleanup after 24 idle hours and capacity-triggered oldest-first cleanup can reclaim any eligible session cache. Sparse disk overselling uses actual allocation and measured headroom only within the authorized CT filesystem; PVE storage discovery and external capacity probes are outside the boundary. Effective leases are never evicted for capacity.

This supersedes [ADR 0015](0015-agent-owned-shared-testbox-workspace.md). Guest isolation replaces shared host paths and caches. Persistent custom services, gateways and implicit keepalive are excluded; native components carry enforcement, while Python entrypoints execute bounded actions. A cached guest may be reused but carries no recovery guarantee.
