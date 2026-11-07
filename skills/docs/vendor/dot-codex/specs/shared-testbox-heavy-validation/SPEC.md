# Shared host execution — superseded

## Context and Scope

This historical topic is superseded by [Native Incus Agent VM](../agent-vm/SPEC.md). The former shared host Skills and helpers are retired; this document supplies no current operating entrypoint. Historical behavior is recorded in [HISTORY](HISTORY.md), with its original source available in Git history.

## Requirements

### REQ-SHARED-TESTBOX-RETIREMENT

Current Linux execution and infrastructure maintenance MUST follow the successor Agent VM contract and its separate Skills. Historical shared-host directories, helpers and cache conventions MUST NOT be used as active routing or a fallback.

## Verification

### VER-SHARED-TESTBOX-RETIREMENT

- covers: `REQ-SHARED-TESTBOX-RETIREMENT`
- Method: active-entry migration check and successor Skill index validation.
- Pass condition: retired Skills and helper code are absent; active routes select the successor while this topic is explicitly marked superseded.

## Related ADRs

None

## References

- [Successor requirements](../agent-vm/SPEC.md)
- [Retirement status](IMPLEMENTATION.md)
- [Historical facts](HISTORY.md)
