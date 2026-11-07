# Review proof ownership 演进历史（#q9r2m）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 共享 proof 从 helper 启动第二层 `codex exec` 改为原生 `$review-agent` task；原因是减少重复模型调用、消除 exec-session/agent-session 混淆，并让任务终态直接成为 ownership 边界。
- proof identity 固定为 `repo_root + head_sha + base_sha + review_profile`；新 SHA 不复用旧结果，同 key 不重复启动。
- review agent 永远只读，`main-agent` 统一负责 findings 聚合、修复、验证、提交和 push；repair push 不重置 `3/2` 预算。
- `6d1ac7f` fix(review): preserve active proof lifecycle
- `8a262c7` docs(review): align proof startup with codex runtime
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#q9r2m`.
