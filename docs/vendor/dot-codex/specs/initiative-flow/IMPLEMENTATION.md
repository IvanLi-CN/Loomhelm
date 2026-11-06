# Initiative Flow Implementation

The implementation has four cooperating surfaces:

They implement only `schema_version=5` and `initiative_contract_version=5`.

- `initiative_plan_contract.py` normalizes the V5 Bootstrap and Delivery JSON contracts and derives topology, task, wave, and digest identities.
- `plan_contract_check.sh` validates the matching human Markdown plan before it becomes runtime input.
- `initiative_flow_guard.py` persists the untracked transactional ledger and enforces the Bootstrap, delivery, CI, and closeout state machine.
- `initiative_flow_replay_check.py` validates compact replay evidence for the V5 activation and child-integration protocol.

The guard begins at `init`. `reuse` verifies passed base-SHA activation evidence; other dispositions create a provisional ledger until the committed Bootstrap SHA receives passed `spec-bootstrap-ci` evidence. The guard exposes the next action through `status` and performs every external transition with a single-use authorization permit.

Every ledger has an `activation` field. A changed-Spec provisional ledger keeps it `null` until Bootstrap Integration CI passes; all ready or externally visible states require the complete record. The named `branch-push` check's SHA is the initial integration frontier and the guard independently resolves the current remote integration branch before Bootstrap CI, Tracking Issue, or topology transitions. Delivery normalizes against that fixed Bootstrap contract and the published topology before any native Ticket task can register.

Promotion, release, observation, Ticket close, receipt sealing, and retention use the same guard identity model. The script and its adjacent tests are the authoritative source for action inputs and receipts; skill prose does not copy their JSON schemas.
