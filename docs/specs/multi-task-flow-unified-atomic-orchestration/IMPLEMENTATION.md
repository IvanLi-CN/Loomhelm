# Unified atomic orchestration implementation

## Canonical persistence

`atomic_nodes` and `atomic_edges` are persisted in the plan and ledger contract. Task and DeliveryUnit records retain compatibility shells and do not persist member arrays or independently authored business status.

## Evaluation

The evaluator treats an empty condition set as invalid at planning time. For a planned milestone, each incoming edge condition and each explicit acceptance criterion contributes one condition; blocked or failed conditions produce `blocked`, all satisfied conditions produce `satisfied`, and otherwise the result is `pending`.

## Migration

Contract 2 task atoms are converted to contribution work nodes when their task and delivery-unit identity is unambiguous. Group atoms and semantic coordination work are rejected for explicit plan revision. The source ledger is backed up and the conversion is idempotent.

## Viewer

The aggregate graph is the default. The atomic graph is derived from the same canonical nodes and edges and includes scope, condition kind, evidence references, derived status and blocker information.
