# Multi-task-flow source size and style gates

Status: accepted

The multi-task-flow package uses pinned Biome as the canonical formatter, linter, import organizer and source-size validator. Biome's `noExcessiveLinesPerFile` rule is configured as an error with a 1000-line limit for production source and a 2000-line limit for test source; the limits count physical lines and do not introduce a physical column-width gate. Lefthook checks staged TypeScript changes before commit, while the existing Candidate CI style check validates the complete package. Production files have no size exemptions; necessary oversized tests require an explicit, reviewed suppression with a reason and owner.
