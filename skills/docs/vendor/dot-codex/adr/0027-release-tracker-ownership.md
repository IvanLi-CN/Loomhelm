---
status: accepted
---

# Distinct CI and Release Tracker Ownership

Delivery uses a dedicated Release Tracker, separate from CI observation, because passed checks do not establish actual publication or production deployment. An authorized release may proceed during a tracker outage, while bounded handle waiting and owner-issued `$flow-continue` retain the unfinished verification obligation without creating a heartbeat, cron, or app automation. Publication identity may differ from the fixed release origin only through a proven repository-owned lineage, supporting release preparation PRs without accepting unrelated artifacts.

Requirements belong to [Release Tracking](../specs/release-tracking/SPEC.md); execution rules belong to the [shared release contract](../../skills/project-engineering-workflow/references/release-tracking-short-contract.md).
