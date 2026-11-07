---
status: accepted
---

# Bind Delivery Workflows to a Code Hosting Platform

Delivery workflows resolve one repository binding from the approved `BASE_REMOTE` and choose an allowlisted code-hosting platform from its host. They call platform capabilities that return normalized facts, require Exact-SHA CI Evidence, and fail closed when a capability is unsupported; GitHub `gh` evidence remains readable for history, while all new receipts are platform-neutral structured facts. This preserves GitHub support while making self-hosted Gitea a first-class target without allowing task text, arbitrary URLs, or missing provider data to redirect or weaken a delivery action.

Initiative Contract v5 remains GitHub-only. A Gitea Repository Binding rejects Initiative entry before creating an Issue, PR, or other external record, because Gitea does not provide the hierarchy semantics its ledger currently requires. This is an explicit capability boundary, not a partial compatibility mode.
