# Loomhelm core topic history

## Lifecycle / Compatibility

The active topic was established on 2026-10-18 from the approved initial product scope. It does not replace an earlier repository topic. There is no previously deployed state or public interface compatibility promise.

## Background

The product combines self-hosted project management with supervised remote Codex execution. Initial scope includes both new sessions and live desktop-session control; unproven control capability remains an acceptance blocker. Autonomous three-level Agent orchestration and interactive plugin view hosting are separate future capabilities.

The owner participates in one complete UI design task, and approved product UI implementation follows that confirmation. Blue-green infrastructure is established and exercised before business iteration, then verified again with the complete business paths.

## Product Boundaries

The owner clarified that the product uses one configured execution environment and has no host-management concept. The existing control-plane ADR continues to describe Server, Worker and Connector separation, execution-machine locality and credential retention; it does not require a fleet-management product. Connector authentication and revocation remain deployment responsibilities.

The owner's initial design direction established cross-project Workbench, Tasks and Conversations entries with separate project-context navigation, list/board/graph views, distinct task hierarchy and dependency relations, shared unsent conversation drafts and independent client navigation. Each task has at most one directly associated conversation; supporting sub-agent activity is presented within that conversation when actual events support it. Files remain in conversation context, without an independent artifacts module or remote file browser.

These product constraints do not constitute approval of the complete UI design. No existing desktop-session control acceptance, deployed schema or public API compatibility evidence is established by the structural prototype.

The owner's design answers permit standalone conversations, optional project selection and later task association without losing conversation identity. Projectless conversations join the target task's project. This corrected the earlier engineering definition that required every Run to have a Task; that checkpoint did not settle reverse association, reassignment or historical visibility. The verified design checkpoint is `1bdbc53f027c7a5575bc267c14ed2d18a38c4bad`.

The complete product requirements were consolidated into `docs/PRD.md` after the owner identified the missing product-definition responsibility. The coordinator owns that document. PRD confirmation and resolution of affected business decisions precede feature implementation and public business contract finalization; complete UI design confirmation remains an additional UI gate. Suggested business rules are collected for owner decision and do not constitute approval or implemented coverage.

The owner further specified a collapsible Projects group with concrete projects and conversation leaves, without a task-navigation level. Project-associated taskless conversations and projectless conversations both need direct access, and project workspaces include task and conversation panels. This navigation clarification is recorded by design checkpoint `0499ba8144200e84b32dd46e8aea5720a9a86999`; it does not establish a nested-project model or completed browser/visual acceptance.

The owner subsequently removed the top-level Conversations button, leaving Workbench and Tasks. The projectless group is named Conversations, and the cross-project All Conversations list remains available from Workbench. Project/conversation trees and project panels remain. This clarification is recorded by design checkpoint `dd3fe9b65cde3c813699ff17f18cb65939a1b142`; old navigation screenshots do not establish acceptance of this layout.

The owner directly confirmed one task per conversation, fixed bindings without replacement/detachment/cross-project migration, private projectless conversations with explicit confirmation before project sharing of historical messages/execution/files, and private same-user drafts. The owner chose automatic last-modification-wins draft reconciliation rather than manual conflict-copy selection, and chose a task status set including Blocked. These answers refine product contracts, not implementation coverage or approval of the entire PRD/design. Business-rule confirmation is consolidated in the parent conversation rather than duplicated in the UI task.

The owner explicitly permitted both task parent/child relationships and prerequisite dependencies across project boundaries. Task relationships preserve the endpoint tasks' project ownership and do not widen project permissions. This decision concerns task relationships and does not change the fixed task/Session binding rule. The design discussion also established system-following theme by default, manual light/dark override and independently remembered choices per client, without selecting a storage technology. Neither clarification establishes implementation coverage or complete product/design approval.

## References

- [Requirements](SPEC.md)
- [Implementation coverage](IMPLEMENTATION.md)
- [Control plane decision](../../adr/0001-control-plane-and-host-execution.md)
- [Deployment decision](../../adr/0002-immutable-candidates-and-blue-green.md)
