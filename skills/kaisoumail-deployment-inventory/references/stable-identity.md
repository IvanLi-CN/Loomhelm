# KaisouMail stable identity

## Canonical naming

- Canonical project / product name: `KaisouMail`
- Use `KaisouMail` in owner-facing summaries unless naming a specific repo path or provider resource.

## Mutable implementation details

These may change over time and must not be treated as the project identity:

- local repo slug
- deployment provider
- provider-side project / service / bucket / database names
- preview hostnames
- provider dashboard URLs

## Current repo relationship

- Current local repo slug: `cf-mail`
- Repo slug is not the canonical product name.

## Writing rules

- Do not rename the whole project after the current hosting provider.
- Do not rename the whole project after one repo slug or one provider resource.
- When an ops note mixes stable identity and runtime facts, write the stable identity first, then the current runtime mapping.

## Inventory split

- Put long-lived identity rules in this file.
- Put current live deployment facts in `current-topology.md`.
