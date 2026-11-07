# 统一手动版本发布实现状态

## Current Status

Implementation: 已实现统一合同与验证入口，正在进行当前 Candidate 的平台验证及 PR 收敛。尚未运行真实发布、通知或生产部署；不能宣称已完成真实首发验收。

## Implementation Coverage

| 合同 | 实现与证据入口 |
| - | - |
| REQ-MVR-001、002 | release-contract、VERSION 投影、Go buildinfo、TS 构建 stamping、Web product-version；policy/projection 单测 |
| REQ-MVR-003 | 签名 release-ledger、精确 ref CAS、追加事件、固定身份字段；裸 Git 并发测试 |
| REQ-MVR-004 | 受保护准备 PR、签名及 exact merge/source/check 验证、平台规则 fail-closed；quality-gates 声明新增发布合同及双平台包检查 |
| REQ-MVR-005、009 | 原生构建 partition、完整 product manifest、独立资产 digest 和共同公开；Linux/macOS 包 CI 与 Node 22/24 检查 |
| REQ-MVR-006、010 | draft 原件保留、公开/完成分阶段、未知结果对账、原身份恢复、completed-only Deploy verify；故障注入测试 |
| REQ-MVR-007 | Go/Web/TS 门禁、426 失败、不可变 build identity、Web 受控错误及 TS Local mode 独立；Go 和 TS 覆盖测试 |
| REQ-MVR-008、011 | Go 独立版本旁路关闭，保留其实现与统一包；可信默认分支通知 sidecar 与身份 Issue 对账 |

## Verification

- `python3 -m unittest discover -s tools/release -p 'test_*.py'`
- `GOTOOLCHAIN=go1.27.2 go test ./internal/buildinfo ./internal/platform ./internal/gateway`
- `node --test clients/typescript/test/version.test.mjs`
- `bun run typecheck` 与 `bun run build`
- `actionlint` 检查本主题新增或修改工作流。
- `bun skills/bin/spec_contract_check.ts --path docs/specs/manual-version-release-delivery/SPEC.md`
- Product Package 的当前 Candidate CI 是原生成品验收入口；真实平台结果绑定实际 run/head，不在本文伪造通过记录。

## Remaining Gaps

平台只读核验时，Release App／签名变量和 secret 名称列表为空，main required checks 已在 owner 单独授权后追加本次三项，保留原八项、strict 与其余保护；追加前已观察三项检查全部通过。真实发布需 owner 配置签名、App、ledger 与 tag 保护。平台漂移不是可忽略的 waiver，不因代码检查通过而推断已对齐。

A6 等待真实 Merge Receipt、owner 首发 target 和授权后执行。没有完整统一产品 baseline 时，必须输入完整版本；本次未选择首发版本。

本机 bootstrap 检出 Go 补丁版本和 sqlc 前置差异；定向 Go 验证使用声明的 go1.27.2，Linux/镜像及数据库验证由 Actions 承担。Markdown 固定工具已恢复；真实程序截图仍受逐次授权约束。

## Compatibility

Go 与 TypeScript 客户端并存，cmd/connector 和 internal/connector 只是现有 Go 实现标识，不是另一产品端。本主题不删除或迁移客户端能力，不改 journal/config 格式，不自动转换旧 tag 或既有业务状态。

候选 schema 2 保持原验证合同，产品级 release manifest 作为额外边界绑定全组件；旧候选不会因文档或版本文件更新而自动成为已发布产品。

## References

- [SPEC](SPEC.md)
- [HISTORY](HISTORY.md)
- [发布操作手册](../../runbooks/manual-product-release.md)
