# CVM imagegen fallback skill 演进历史（#q3wyh）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- 2026-06-27: 新增 `cvm-imagegen` 作为独立 skill，而不是修改系统 `.system/imagegen`。
- 2026-06-27: 采用薄包装 wrapper，复用系统 fallback 的参数解析与业务逻辑，只替换 `CVM_API_KEY` 校验和 OpenAI client 构造。
- 2026-06-27: 将 skills 索引同步为可发现入口，避免该能力只存在于私有约定中。

## Key Reasons / Replacements

- 系统 skill 不适合作为本仓长期策略承载层，直接修改容易被更新覆盖。
- 当前需求是自定义 BaseURL fallback，而不是重写整套 image workflow。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#q3wyh`.
