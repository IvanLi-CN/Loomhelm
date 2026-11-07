# <Human-readable topic title>

> This file is the durable topic requirements contract. Current implementation facts belong in `IMPLEMENTATION.md`; lifecycle and change references belong in `HISTORY.md`.

## Context and Scope

- Context: <the stable problem or capability this topic owns>.
- In scope: <the boundary covered by this topic>.
- Out of scope: <the neighboring behavior owned elsewhere>.

## Terms and Interfaces

- `<term>`: <stable domain meaning>.
- Interface: <public command, file, API, or workflow boundary, if applicable>.

## Requirements

### REQ-<TOPIC>-001

- The system MUST <state one observable, durable behavior or constraint>.
- Inputs: <accepted inputs and boundary conditions>.
- Outputs: <observable result or state>.

### REQ-<TOPIC>-002

- The system MUST <state the next independently verifiable requirement>.

## Verification

### VER-<TOPIC>-001

- Method: <test, fixture, inspection, or invariant check>.
- covers: `REQ-<TOPIC>-001`
- Pass condition: <observable assertion>.

### VER-<TOPIC>-002

- Method: <second independent verification>.
- covers: `REQ-<TOPIC>-002`
- Pass condition: <observable assertion>.

## Related ADRs

None

## Visual Evidence

<!-- Optional: normative owner-facing assets only. PR image selection is task evidence, not Spec content. -->

- None

## References

- `./IMPLEMENTATION.md`
- `./HISTORY.md`
