# ADR 0039: Fresh Dispatch Task Title Contract

- Status: Accepted
- Date: 2026-11-02
- Related: `skills/fresh-thread-dispatch/SKILL.md`, `skills/fresh-thread-dispatch/references/handoff-envelope.md`

Fresh dispatch currently omits the native `create_thread.title` field when the owner did not provide a title. The platform then derives a user-facing title from the structured handoff prompt, exposing the `Goal` protocol label and copying a long task sentence. This makes the task list harder to scan and couples user-facing metadata to the prompt envelope.

Resolve and pass a task title explicitly for every fresh dispatch. An explicit owner title has priority and may receive only whitespace normalization; an overlong explicit title must not be silently truncated. Otherwise derive the title only from the transferred task intent, using the primary outcome rather than the full sequence of investigation, implementation, and verification steps. Use the concise `action + subject + decision boundary` form, target no more than 24 Unicode code points, and enforce a 32-code-point hard limit for generated titles. Remove protocol labels, skill references, URLs, paths, acceptance details, and execution context from the generated result. If no meaningful title can be derived, use `移交任务`.

The full handoff prompt remains structured and complete; title generation must not parse or infer from `Verified context`, `Scope and constraints`, or `Execution and stop condition`. The request builder only validates and forwards the resolved title. The rule applies only to fresh dispatch and does not alter other thread-creation or existing-thread title behavior.

Examples include `审查 CONSOLE_RUNTIME 必要性`, `设计运行时配置下发`, and `修复移动端发布布局`. The implementation must test explicit-title forwarding, Goal-based derivation, protocol and metadata exclusion, semantic shortening, the `移交任务` fallback, and preservation of ledger metadata boundaries.
