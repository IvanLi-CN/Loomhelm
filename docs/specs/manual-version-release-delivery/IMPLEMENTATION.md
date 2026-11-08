# 统一手动版本发布实现状态

## Current Status

Implementation: 统一合同及原生包验证入口已由 PR #77 合并，合并提交 c45218ad238ef4f56621f832fcfb086bb2bc679e 的主干 CI 已通过。后续修正使用现有认证、GitHub 原生签名提交和 main 保护审计；当前 follow-up 仍需其自身的 CI 与正式审查。真实首发、通知及恢复尚未验收。

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

A6 已有真实 Merge Receipt；owner 已将真实首发纳入后续执行，但完整版本目标与明确发布授权仍待提供，不自动选择 patch 或完整版本。GitHub API 返回不可见或无权限时，记录 unknown，而非宣称资源不存在。

## Compatibility

Go 与 TypeScript 客户端并存，cmd/connector 和 internal/connector 只是现有 Go 实现标识，不是另一产品端。本主题不删除或迁移客户端能力，不改 journal/config 格式，不自动转换旧 tag 或既有业务状态。

候选 schema 2 保持原验证合同，产品级 release manifest 作为额外边界绑定全组件；旧候选不会因文档或版本文件更新而自动成为已发布产品。

## References

- [SPEC](SPEC.md)
- [HISTORY](HISTORY.md)
- [发布操作手册](../../runbooks/manual-product-release.md)
