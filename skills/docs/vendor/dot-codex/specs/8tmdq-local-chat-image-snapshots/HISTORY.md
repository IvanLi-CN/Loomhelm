# 本地聊天图片快照存储 演进历史（#8tmdq）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `f9ebf1c` feat(images): snapshot local chat images
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- 2026-04-11: 新建 follow-on 规格，锁定本地聊天图片必须先快照的实现方案。
- 2026-04-11: 完成 helper、git ignore 与受影响提示词/skills 契约同步。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#8tmdq`.
