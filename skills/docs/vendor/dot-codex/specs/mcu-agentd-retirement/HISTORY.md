# mcu-agentd 集成清退主题历史

## Lifecycle / Compatibility

本主题约束我们维护的 mcu-agentd 现行集成与推荐的退役。主题处于 active，实施状态由 `IMPLEMENTATION.md` 单独记录；规范存在不代表清退已经完成。

不保留兼容 Skill、重定向入口或替代工具承诺。必要的过去事实可以留存，不能作为当前推荐来源。

## Decision Sources

- 主人明确指出：“mcu-agentd 过时了，我们不再使用这个了，需要彻底清退。”
- 第一轮确认清退 dot-codex 与 agent-toolkit 的现行集成，机器部署和具体项目接入不纳入。
- 对后续工具的边界，主人明确要求：“我们清退我们的，不再提这事就行了，各项目自己用什么就用什么，我们也不需要关心。”因此不要求回到某种工具链，也不调查、迁移或验证各项目的选择。
- 对新发现的 style-playbook 来源，主人确认一并清退我们维护的现行推荐，保留必要历史事实，避免历史快照再次形成推荐或规则。

## Documentation Boundary

`grill-with-docs` 收敛上述需求；`topic-spec` 仅将已收敛的长期约束写入规范。本主题没有需要另立 ADR 的难逆转架构决定。

## Implementation Boundary

dot-codex 已清退私有硬件操作 Skill、能力索引与 Git 白名单，并移除旧项目的专属 trusted 登记；两份旧服务退役规格保留其余治理内容并删除失效的现行引用。agent-toolkit 与 style-playbook 的受维护源头已分别完成并合并清退 PR；安装环境是否同步仍与源头结果分开报告。

## Related Changes

- None

## References

- [主题规范](./SPEC.md)
- [实现状态](./IMPLEMENTATION.md)
