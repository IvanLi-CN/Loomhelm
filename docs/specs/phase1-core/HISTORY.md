# Loomhelm core topic history

## Lifecycle / Compatibility

The active topic was established on 2026-10-18 from the approved initial product scope. It does not replace an earlier repository topic. There is no previously deployed state or public interface compatibility promise.

## Background

The product combines self-hosted project management with supervised remote Codex execution. Initial scope includes both new sessions and live desktop-session control; unproven control capability remains an acceptance blocker. Autonomous three-level Agent orchestration and interactive plugin view hosting are separate future capabilities.

The owner participates in one complete UI design task, and approved product UI implementation follows that confirmation. Blue-green infrastructure is established and exercised before business iteration, then verified again with the complete business paths.

## Product Boundaries

The owner clarified that the product uses one configured execution environment and has no host-management concept. The existing control-plane ADR continues to describe Server, Worker and Connector separation, execution-machine locality and credential retention; it does not require a fleet-management product. Connector authentication and revocation remain deployment responsibilities.

The owner's design direction establishes cross-project Workbench, Tasks and Conversations entries with separate project-context navigation, list/board/graph views, distinct task hierarchy and dependency relations, shared unsent conversation drafts and independent client navigation. Each task has at most one directly associated conversation; supporting sub-agent activity is presented within that conversation when actual events support it. Files remain in conversation context, without an independent artifacts module or remote file browser.

These product constraints do not constitute approval of the complete UI design. No existing desktop-session control acceptance, deployed schema or public API compatibility evidence is established by the structural prototype.

## References

- [Requirements](SPEC.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Control plane decision](../../adr/0001-control-plane-and-host-execution.md)
- [Deployment decision](../../adr/0002-immutable-candidates-and-blue-green.md)
