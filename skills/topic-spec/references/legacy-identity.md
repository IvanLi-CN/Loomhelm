# Legacy identity resolution

Legacy paths stay readable. They are never a naming model for new work.

## Readable compatibility inputs

- `docs/specs/<legacy-id>-<topic>/` directories that predate companion docs.
- `docs/plan/<legacy-id>-<title>/PLAN.md` and `docs/specs/**/PLAN.md` in legacy repositories.
- Retained read-only aliases after the catalog becomes slug-only.

## Establishing a canonical target

A canonical target may be selected only with one of these proofs:

1. an explicit canonical path supplied by the caller;
2. a same-diff Git rename recorded in the change;
3. a historical catalog row proving the exact `ID + source path`, resolved relative to the catalog directory and allowing inline-code or Markdown-link wrapping;
4. one unique slug target with that same catalog proof;
5. for a retained read-only alias, an exact marker line in the canonical `HISTORY.md` of the form `- Legacy compatibility identity: `#<id>``, where `<id>` is replaced by the retained identifier.

## Never proof

A four- or five-character prefix alone is not proof: `audit-logs` must not be rewritten to `logs`. When the mapping is not proven, or more than one canonical target is plausible, block and ask for the canonical target instead of guessing.

## Migration boundary

Creating the canonical target, normalizing legacy directories, and updating inbound references belong to `$docs-migrate` (`MODE=specs` and `MODE=specs-hygiene`). Sync mode only writes to an already resolved canonical Spec.
