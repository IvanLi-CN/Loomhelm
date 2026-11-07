# Code Hosting Platform Boundary 主题历史

> 这里记录主题局部生命周期、兼容性与必要背景；完整取舍保留在 ADR 中。

## Lifecycle / Compatibility

- 新主题：现有交付流程以 GitHub `gh` 为事实来源；本主题建立平台无关控制面，并保留历史 GitHub 证据的只读兼容。
- Initiative Contract v5 保持 GitHub-only；Gitea 不采用模拟子议题的兼容模型。

## Replacements / Background

- [ADR 0020](../../adr/0020-code-hosting-platform-boundary.md) 记录平台选择、能力失败关闭和 Initiative 边界。
- `docs/solutions/workflow-issues/forge-transport-decoupling.md` 记录 Gitea API 与 Tea 能力研究。

## Contract Notes

- CI facts 使用四字段 envelope 区分 required policy、checks expectation、exact-SHA evidence 和 gate effect；policy observation error 保留 typed evidence，不能被适配器改写成 required-check blocker 或无检查成功。
- 独立 status/check/run surface 在 policy 读取失败时仍尽力收集；手动、schedule、release、publish、deploy/deployment 和无关 SHA 的 runs 不进入 PR CI evidence。
- Rerun 安全性按 provider、repository、run identity 和 exact SHA 绑定：并发调用共享同一个 in-flight mutation，确定性的发送前错误可以重试，不明确的 mutation 结果保留一次性 claim。
- 当 repeated context 的 timestamp 只有部分存在且 attempt 相同时，使用可比较的 run identity 选择较新 observation；仍无法比较时才按失败优先级保守归约。

## Related Changes

- None

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
