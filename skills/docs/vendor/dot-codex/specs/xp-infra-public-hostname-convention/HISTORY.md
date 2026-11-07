# XP Infra 公网 hostname 规范主题历史

## Lifecycle / Compatibility

- 标准公网节点采用严格成对 hostname；private Docker exception 不在该公网合同内。

## Replacements / Background

- 此规范新增后，任意 legacy API hostname 都作为 drift 报告，而不通过自动兼容 alias 继续保留。

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- `../../adr/0002-xp-infra-public-hostname-convention.md`
