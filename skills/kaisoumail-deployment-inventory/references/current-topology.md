# KaisouMail current deployment inventory

## Table of contents

- [Verification basis](#verification-basis)
- [Stable naming rules](#stable-naming-rules)
- [Current verified production entrypoints](#current-verified-production-entrypoints)
  - [Web entrypoints](#web-entrypoints)
  - [API entrypoints](#api-entrypoints)
- [Current verified runtime resources](#current-verified-runtime-resources)
  - [API runtime](#api-runtime)
  - [Email runtime](#email-runtime)
  - [Database / object storage](#database--object-storage)
- [Current verified zone / mail routing facts](#current-verified-zone--mail-routing-facts)
- [Current verified DNS pressure signal](#current-verified-dns-pressure-signal)
- [Current verified drift between repo and live runtime](#current-verified-drift-between-repo-and-live-runtime)
- [Current provider-specific pages to open first](#current-provider-specific-pages-to-open-first)
- [Guardrails for future updates](#guardrails-for-future-updates)

## Verification basis

- This inventory is based on an authenticated control-plane inspection performed on 2026-04-19 (Asia/Shanghai).
- Current verified hosting / control-plane provider at that time: `Cloudflare`
- This is current state, not a permanent architectural guarantee.
- When live control-plane state conflicts with checked-in config, prefer the live control-plane state.

## Stable naming rules

- Canonical project / product name: `KaisouMail`
- Local repo slug: `cf-mail`
- Current provider-specific resource names may use labels such as `cf-mail` or `kaisoumail-*`.
- Never refer to the whole project as `cf-mail` or `Cloudflare mail`; use `KaisouMail` unless naming a specific repo path or runtime resource.

## Current verified production entrypoints

### Web entrypoints

- Public web domains:
  - `https://cfm.707979.xyz`
  - `https://km.707979.xyz`
- Current preview hostname:
  - `https://cf-mail-e7s.pages.dev`
- Current provider resource serving the web app:
  - Cloudflare Pages project resource name: `cf-mail`
  - This is a provider-side resource name, not the canonical project name.

### API entrypoints

- Public API domains:
  - `https://api.cfm.707979.xyz`
  - `https://api.km.707979.xyz`
- Current provider resource serving the API:
  - Worker / service name: `kaisoumail-api`
- Current `workers.dev` hostname retained for provider-side access:
  - `kaisoumail-api.ivanli2048.workers.dev`

## Current verified runtime resources

### API runtime

- Service name: `kaisoumail-api`
- Cron trigger: `*/15 * * * *`
- Visible runtime vars include:
  - `MAIL_DOMAIN=707979.xyz`
  - `WEB_APP_ORIGIN=https://cfm.707979.xyz`
  - `WEB_APP_ORIGINS=https://cfm.707979.xyz,https://km.707979.xyz`
  - `EMAIL_WORKER_NAME=email-receiver-worker`
  - `EMAIL_ROUTING_MANAGEMENT_ENABLED=true`

### Email runtime

- Service name: `email-receiver-worker`
- No public custom domain
- Provider-side hostname retained:
  - `email-receiver-worker.ivanli2048.workers.dev`
- Visible runtime vars include:
  - `MAIL_DOMAIN=707979.xyz`
  - `EMAIL_ROUTING_MANAGEMENT_ENABLED=false`

### Database / object storage

- Current production database resource name: `cf-mail-db`
  - UUID: `460e9fd5-002f-4d45-82be-6d1d6c7abf3a`
- Current preview database resource name: `cf-mail-db-preview`
  - UUID: `3584c425-b4df-485f-b863-2db411db8c8e`
- Current object storage buckets visible in the provider control plane:
  - `cf-mail-bucket`
  - `cf-mail-bucket-preview`
  - `kaisoumail-bucket`
- Current API runtime binding still points to `kaisoumail-bucket`.

## Current verified zone / mail routing facts

- Relevant active zones visible in the current provider account include:
  - `707079.xyz`
  - `707979.xyz`
  - `fkoai.asia`
  - `ivanli.asia`
- `707979.xyz` is active and currently shown as `Free` plan.
- Current nameservers shown for `707979.xyz`:
  - `sloan.ns.cloudflare.com`
  - `theo.ns.cloudflare.com`
- `707979.xyz` Email Routing currently has an active catch-all rule targeting `email-receiver-worker`.
- The email worker is shared across multiple visible zones, not only KaisouMail-owned traffic surfaces.

## Current verified DNS pressure signal

- The `707979.xyz` DNS records page currently shows: `1 到 50，2,988 个 已添加记录`.
- Visible samples include many mailbox-style record names such as `box-*` entries backed by Cloudflare MX records.
- The report that DNS record capacity is exhausted or nearly exhausted is credible.
- Start cleanup from dependency mapping, not blind deletion: first map old `box-*` records to still-live mailbox / routing state.
- Do not state an exact provider quota number unless it is freshly re-verified from an official source and matches current dashboard behavior.

## Current verified drift between repo and live runtime

- The repo and product branding call the project `KaisouMail`.
- The local repo slug is `cf-mail`.
- The current web-app provider resource name is `cf-mail`.
- Some repo docs still describe an intended Pages project name `kaisoumail`.
- The current production database resource name is `cf-mail-db`, but checked-in config still references the same UUID under legacy name `kaisoumail-db`.
- The current API runtime still uses legacy names like `kaisoumail-api` and `kaisoumail-bucket`.

## Current provider-specific pages to open first

These URLs are current-state operational shortcuts, not permanent contracts.

- Domains overview:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/domains/overview`
- `707979.xyz` DNS records:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/707979.xyz/dns/records`
- `707979.xyz` Email Routing routes:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/707979.xyz/email/routing/routes`
- Web app custom domains:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/pages/view/cf-mail/domains`
- Web app settings:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/pages/view/cf-mail/settings`
- API runtime settings:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/workers/services/view/kaisoumail-api/production/settings`
- Email runtime settings:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/workers/services/view/email-receiver-worker/production/settings`
- Database overview:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/workers/d1`
- Object storage overview:
  - `https://dash.cloudflare.com/6a0a9f87ad8820dc003b21529cdce222/r2/overview`

## Guardrails for future updates

- If hosting changes away from Cloudflare, update this file instead of creating a new vendor-branded skill.
- Keep the skill provider-agnostic; keep provider specifics inside the current-topology reference.
- Prefer control-plane inspection over repo guesses when asked “what is live right now”.
- Do not delete DNS records, routes, buckets, or databases without first confirming which runtime resource still depends on them.
- If browser auth expires or the dashboard requires 2FA, stop and ask the user to re-authenticate manually.
