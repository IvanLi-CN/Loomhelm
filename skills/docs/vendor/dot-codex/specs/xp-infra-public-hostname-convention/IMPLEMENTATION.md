# XP Infra 公网 hostname 规范实现状态

## Current Status

- Implementation: 已实现
- Lifecycle: active
- Catalog note: policy 与只读审计已验证标准公网节点的两种 hostname。

## Coverage / rollout summary

- `xp-infra` policy 固定公共 Zone。
- 审计比较节点名、API hostname 与 endpoint hostname。
- fixture 覆盖 hostname mismatch、private Docker skip（包括无效节点名）、无效节点名和 60 字符边界。

## Remaining Gaps

- 存量节点的 DNS、Tunnel 与 Raft metadata 迁移需要单独授权。

## Related Changes

- None

## References

- `./SPEC.md`
- `./HISTORY.md`
