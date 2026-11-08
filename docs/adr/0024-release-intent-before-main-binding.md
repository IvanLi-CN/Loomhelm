# ADR 0024：主干版本绑定前的发版意图核验

## 状态

已接受。Owner 明确修正版本复用边界：版本能否继续使用取决于实际变更是否超过原发版意图；版本已固定到 main 时只能发布对应代码，未固定时允许经过核验后继续使用。

## 背景

准备 PR 的 CI 运行期间 main 可以继续前进。把初始 dispatch source 永久视为最终源码，会将普通开发合并误变成版本作废条件。ADR 0022 的准备阶段冻结边界由本决定接续；ADR 0023 的现有认证、签名和 CAS 保持不变。

## 决策

区分原始发版意图、准备修订和已合入 main 的产品版本。保留原 reservation、canonical version、初始 intent 和历史；在版本尚未落入 main、没有构建 claim、资产、tag 或 Release 时，owner 或获授权的 agent 可以核验实际 diff，并签名追加 preparation_reconciled 事件及 preparation_revisions。该事件显式采用 pre-main-intent-v1，不覆盖旧记录，不重新计算版本或分配 successor。

核验必须记录原版本、前一 source、新 source、完整 changed_paths、within-intent 判断、理由、证据与 release owner。仅版本大小、文件名或 main 发生变化不能替代判断。超出原意图或证据缺失时拒绝接续，由 owner 明确调整发版意图或版本；不默认 patch。

准备分支按普通 PR 流程吸收新主干并重新运行门禁；reconcile 校验实际 source 与准备 head、签名、PR 状态和精确版本投影字节。新增业务代码必须完整包含在已评估 main source，不能藏入 VERSION、package 或 lock 的投影改动。每次合并前仍以精确 head/base 守卫；main 再次前进时重新核验实际增量，不自动烧掉版本。

以 main 的实际 Git 历史及已合并准备 PR 识别版本是否固定，不能只看当前 VERSION 或 ledger 是否及时写入 bound。即使后来 main 改成另一版本，也不得将旧版本转给不同代码。版本落入 main 后，绑定该准确 merge SHA；构建和公开后的原身份、版本、SHA、channel 与 digest 均保持不变。

显式终止保留历史。尚未固定到 main 的已终止准备身份可以在同一 owner、同一版本且实际变更仍在原意图内时显式恢复；不删除墓碑、不将占用转交任意新 identity。已固定到 main 的版本始终不能换源码。

## 状态兼容与验证

沿用 ledger schema 1，preparation_revisions 为可选追加字段；旧记录无需回填，初始 preparation_sha 和 intent 保持不可变。新版读取并验证修订及对应事件，按最新已核验准备信息绑定。旧程序在绑定前找不到其旧 preparation_sha 对应的精确合并 PR，拒绝接续，不把修订伪装成旧源码发布；已绑定产物格式保持不变。回滚程序不撤销修订。

真实临时 Git 历史测试覆盖意图内接续、意图外拒绝、历史 VERSION 已落 main、缺失 bound 回执、原身份恢复、投影外或 lock 隐藏改动、事件不可改写和最终 merge 绑定。

## 依据

- [统一发布合同](../specs/manual-version-release-delivery/SPEC.md)
- [Manual version release delivery](https://github.com/IvanLi-CN/style-playbook-skills/blob/main/skills/style-playbook/references/topics/manual-version-release-delivery/TOPIC.md)：Version Policy、明确 reservation release 规则、精确 source/merge provenance 与同身份恢复。
