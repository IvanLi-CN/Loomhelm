# Release Tracking History

The former shared contract named `post-merge-release-tracker` without a registered role. Its thirty-minute observation rule also lacked same-chat recovery and assumed artifacts used the originating merge SHA. The dedicated role and this topic own those boundaries, while CI and pre-merge release decisions remain in their existing topics. Same-SHA publication evidence remains compatible.

Source implementation and deterministic verification are delivered in [PR #167](https://github.com/IvanLi-CN/dot-codex/pull/167); runtime installation and acceptance remain separate.

The current contract now forbids scheduled tracking and requires a live tracker handle plus owner-issued `$flow-continue` for recovery. Earlier scheduled-task wording and replay fixtures remain historical audit compatibility material; existing runtime automations are intentionally untouched.
