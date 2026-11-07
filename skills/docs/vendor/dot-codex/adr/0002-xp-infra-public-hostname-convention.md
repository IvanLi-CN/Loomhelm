---
status: accepted
---

# XP Infra 公网 hostname 采用成对严格命名

标准公网 XP 节点的控制面和托管 endpoint 分别使用 `<node>-xp.707979.xyz` 与 `<node>-ep.707979.xyz`。其中 `<node>` 是节点运行时声明的原始小写 DNS label，最多 60 个字符，以便角色后缀仍留在同一个有效 DNS label 内；不能为了 DNS 或 Tunnel 冲突添加随机或数字后缀。

选择严格审计而不是把现有 hostname 视为节点名称的一部分，是为了让节点身份、控制面入口和 endpoint 入口保持可预测的一对一关系。冲突应停下来由操作员解决；静默生成后缀或覆写现有记录会把错误身份写入集群元数据。

已有节点若不符合该规则，`xp-infra audit` 必须报告 drift，但不得自动变更 DNS、 Tunnel 或节点配置。其迁移需要单独的主人授权。
