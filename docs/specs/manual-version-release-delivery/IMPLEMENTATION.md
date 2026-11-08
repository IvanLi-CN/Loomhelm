# 统一手动版本发布实现状态

## Current Status

Implementation: 统一发布合同及原生包入口已实现。Owner 指定并授权的 [0.1.0 正式发布](https://github.com/IvanLi-CN/Loomhelm/releases/tag/v0.1.0) 已完成，准确源码为 f2d268f462f7dd91d5b7bbeda45873c18d82b7f6，完整八项资产与 [签名 completion](https://github.com/IvanLi-CN/Loomhelm/blob/226c90f00f2daae22be274c01a98f3b43488cd44/ledger.json) 一致。[真实 Release run 42450011670](https://github.com/IvanLi-CN/Loomhelm/actions/runs/42450011670) 的四个原生构建与发布任务成功。已完成身份的只读恢复实际下载复核全部资产，ledger head 保持不变；这不冒充部分上传中断或故障通知演练。

## Implementation Coverage

| 合同 | 实现与证据入口 |
| - | - |
| REQ-MVR-001、002 | release-contract、VERSION 投影、Go buildinfo、TS 构建 stamping、Web product-version；policy/projection 单测 |
| REQ-MVR-003 | 签名 release-ledger、精确 ref CAS、追加事件、固定身份字段；裸 Git 并发测试 |
| REQ-MVR-004 | 受保护准备 PR、签名及 exact merge/source/check 验证、平台规则 fail-closed；quality-gates 声明新增发布合同及双平台包检查 |
| REQ-MVR-005、009 | 原生构建 partition、完整 product manifest、独立资产 digest 和共同公开；Linux/macOS 包 CI 与 Bun 1.4.4 源码运行与 FFI 检查 |
| REQ-MVR-006、010 | draft 原件保留、公开/完成分阶段、未知结果对账、原身份恢复、completed-only Deploy verify；故障注入测试 |
| REQ-MVR-007 | Go/Web/TS 门禁、426 失败、不可变 build identity、Web 受控错误及 TS Local mode 独立；Go 和 TS 覆盖测试 |
| REQ-MVR-008、011 | Go 独立版本旁路关闭，保留其实现与统一包；可信默认分支通知 sidecar 与身份 Issue 对账 |

缺失 ledger 时只将包含完整正式版或预发布版本及身份后缀的准备分支视为发布历史，普通开发分支不会阻断首发。正式发布从 bound 进入 staged 前必须已有持久构建 claim，manifest 的 run 与 attempt 必须与该来源一致；缺失或不符在上传前拒绝。

准备阶段的 reconcile 以实际 diff、owner、理由和证据核验原发版意图，签名追加 preparation_revisions，不覆盖原始 reservation。main 的历史 VERSION 和已合并 PR 决定版本是否固定，不把缺失 bound 回执或 main 后来换版本当作可换源码的许可。bind 和 Release 适配读取最新已核验准备修订；临时 Git 历史测试覆盖重复接续、原身份恢复、意图外拒绝、投影字节及主干绑定边界。

准备分支合入其他 base 不等于版本落 main；主干历史和已合并 main PR 的拒绝条件继续有效。非 object 的 assessment 在 provider 或 ledger 写入前返回受控错误。失败 sidecar 将缺失或空的身份附件按可信 workflow-run 元数据通知，非空但损坏的附件继续拒绝；既有 run marker 查询防止重复 Issue，不编造产品身份。

## Verification

- `python3 -m unittest discover -s tools/release -p 'test_*.py'`
- `GOTOOLCHAIN=go1.27.2 go test ./internal/buildinfo ./internal/platform ./internal/gateway`
- `bun test clients/typescript/test/version.test.ts`
- `bun run typecheck` 与 `bun run build`
- `actionlint` 检查本主题新增或修改工作流。
- `bun skills/bin/spec_contract_check.ts --path docs/specs/manual-version-release-delivery/SPEC.md`
- Product Package 的当前 Candidate CI 是原生成品验收入口；真实平台结果绑定实际 run/head，不在本文伪造通过记录。

## Remaining Gaps

main 已有原生分支保护，required checks 共十一项，strict、签名及管理员保护有效。此前只检查 Rulesets 导致的误判已修正。额外 App、发布私钥和强制 Rulesets 不再是前置条件，不能把不采用这些方案记为配置缺失。

仓库当前禁止 Actions 创建 PR；保持该设置，版本准备分支由工作流创建，普通 PR 由 owner 或已获授权的 agent 用现有 gh 身份打开。内置令牌不能读取管理员级保护详情；CI 只验证可见 protected 与 required contexts，完整配置由 owner 现有 gh 审计并保留证据。发布运行另外拒绝无精确 main 合并 PR、无签名或检查不通过的真实源码。写权限与平台签名的真实行为必须在授权发布时观察；PR fixtures 不能证明真实发布成功。

A6 的完整版本输入、授权、准确 Merge Receipt、真实首发和完成后同身份只读恢复已有证据。部分上传中断恢复、公开后丢失 completion 的真实故障注入及产品身份 Issue 投递仍未演练，不能因 fixtures 或成功首发而记为全部通过。旧 Manual Release run 42437677675 的空附件通知曾失败于 JSON 解析，独立修复补充回归测试；实际通知重试须另记平台结果。后续产品发版仍需 owner 指定 target，不自动选择 patch。GitHub API 不可见或无权限时保留 unknown。

## Compatibility

Go 与 TypeScript 客户端并存，cmd/connector 和 internal/connector 只是现有 Go 实现标识，不是另一产品端。本主题不删除或迁移客户端能力，不改 journal/config 格式，不自动转换旧 tag 或既有业务状态。

候选 schema 2 保持原验证合同，产品级 release manifest 作为额外边界绑定全组件；旧候选不会因文档或版本文件更新而自动成为已发布产品。

## References

- [SPEC](SPEC.md)
- [HISTORY](HISTORY.md)
- [发布操作手册](../../runbooks/manual-product-release.md)
