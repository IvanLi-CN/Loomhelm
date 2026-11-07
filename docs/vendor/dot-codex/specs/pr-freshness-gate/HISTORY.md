# PR freshness gate 演进历史（#s7gvk）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- Concurrent provider reads can finish out of order; correlated replay observations therefore retain call-start ordering instead of allowing late older `CLEAN`/`BEHIND` results to erase a newer conflict.

- Ordinary target advancement is handled at the end of a bound review/CI round instead of canceling live work. Actual conflict or invalid validation assumptions retain prompt diagnosis; final merge gates remain strict, and adopted review-base changes still require fresh evidence. This replaces blanket `BEHIND` admission blocking and repeated automatic rebase.
- Starting-commit provenance remains distinct from a fixed delivery target; necessary alignment still requires existing authority. The original PR #119/session `019ce2c6-a339-77b0-9044-2903ee310ee2` demonstrated a real repository stale-branch merge rejection; that case does not establish that every unrelated target advance must interrupt review.
- `aca3834` fix(skills): gate stale prs before convergence
- `b39a914` docs(specs): adopt topic-level spec model

## Legacy Change Log

- 2026-03-13: 新增 PR freshness gate 规格并完成相关 skill 契约收敛。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#s7gvk`.
