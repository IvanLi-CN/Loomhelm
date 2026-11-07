# History

- The flow-scoped policy now requires a persisted Wave Thread task class with every locked profile, keeps pre-policy v2 state read-only until explicit migration, rejects stale parent bases and duplicate dispatch claims, and preserves historical profile events across an explicit owner replacement while rejecting new unbound owner-override events.

- The shared project-engineering direct-review contract now defines the exact six-profile autonomous allowlist, lane-local selection, complete-pair owner overrides scoped to an invocation or named lane, and runtime-owned rejection without silent fallback.

- Flow-specific profile policies were agreed for Code Review and Wave Thread: each flow has an independent allowlist, Code Review lanes choose independently, Wave Thread tasks lock one profile, and a direct complete owner-specified pair may bypass the corresponding allowlist while runtime support remains authoritative.

- Direct review moved from receipt-enforced profile ladders to lane-level guidance and direct structured evidence.
- Formal review launch is now readiness-gated and runtime-created per current Candidate; the plan's profile is advisory and terminal reviewers are never reused.
- Readiness now covers acceptance, scope, required contracts, and validation across the local-merge consumer; direct plans must align strategy/profile guidance with their selected tier, and structured lane evidence must bind exact scope and a non-empty actual profile without unknown fields.
- The direct-plan checker now verifies that Tier 3/4 recommendations name a concrete supported model/effort pair and that runtime strategy text includes an explicit formal-lane launch/create action.
- Structured replay now rejects unknown disposition values before any repair or report-only classification.
- Structured replay now requires explicit readiness and a demonstrated finding before initial formal launch or In-Scope repair.
- Structured replay now rejects unsupported actual profiles and unknown dispositions embedded in terminal findings.
- Structured replay now distinguishes demonstrated findings from observations before authorizing an In-Scope repair.
- Structured replay rejects missing or unknown finding kinds before terminal clear state.
- Valid terminal clear evidence may report a blocking finding; unavailable or malformed review output alone is `unchecked`.

- 当前合同将 transcript/profile attestation 降为历史兼容信息。显式启动 profile 仍做低成本输入校验，PTC 与 direct 传输等价；direct-flow review proof 改由 helper-owned structured `ReviewReceipt` 决定，advisory review 不能替代该 proof。

- Workflow agent models were previously treated as exact stage and lane requirements. That made review and delegated work unavailable when a recommended override could not be launched.
- The contract now separates preferred planning profiles from resolved runtime profiles and permits one bounded explicit replacement fallback before startup.
- Native v3 review evidence now records the tool-observed resolved model and reasoning effort, and rejects missing or mismatched task-envelope values before accepting a lane receipt.
- The v3 envelope was still caller-controlled and could infer a fallback from a preferred/resolved mismatch. Schema v4 replaces that inference with a common native launch hook, one-time pre-start permit, and transcript-derived runtime attestation.

## Wave Thread 移除

Wave Thread 专属三档 Profile 与派发回放已经删除。直接 Review 和现行多任务流程的 Profile 规则继续由各自合同负责。
