---
name: kaisoumail-deployment-inventory
description: "Use when Codex needs to identify where KaisouMail is currently deployed, which public entrypoints and runtime resources are live, how current provider resources differ from repo config, or which control-plane page should be checked first during ops work. Treat the hosting provider as current verified state, not as a permanent project identity."
---

# KaisouMail Deployment Inventory

## Quick start

- Read `references/stable-identity.md` before writing owner-facing notes.
- Read `references/current-topology.md` before making claims about the live deployment.
- Treat the authenticated control plane and live runtime evidence as the source of truth for current hosting, bindings, public domains, and triggers.

## Working rules

- Use `KaisouMail` as the canonical project / product name.
- Treat repo slugs, provider resource names, and hosting vendors as mutable implementation details.
- Distinguish three layers in every ops note: canonical product name, current repo / resource names, current hosting provider.
- Use `$ego-browser` for interactive verification. Keep an inspected page only when the user asks for it to remain open.
- Never expose secret values from dashboards; secret names and non-secret resource identifiers are fine.

## Incident flow

1. Identify the current provider and public entrypoints from `references/current-topology.md`.
2. Open the provider-specific control-plane page listed in that reference.
3. Compare live resources with checked-in config only after the live state is clear.
4. Report in this order when possible: outcome -> live evidence -> affected resources -> safe next step.

## Updating the inventory

- Update `references/current-topology.md` when hosting, resource names, domains, bindings, or operational entrypoints change.
- Keep long-lived naming rules in `references/stable-identity.md`.
- Keep provider-specific facts in the current-topology reference instead of baking them into the skill name or core instructions.

## References

- `references/stable-identity.md`
- `references/current-topology.md`
