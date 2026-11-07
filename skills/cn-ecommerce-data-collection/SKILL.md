---
name: cn-ecommerce-data-collection
description: "Collect Taobao/JD/1688 data with browser assistance."
---

# CN E-commerce Data Collection (ego-browser-first)

## When this skill applies

Use this workflow when:

- The target site is **Taobao/Tmall/JD/1688** (淘宝/天猫/京东/1688), or similar shopping platforms.
- The site shows anti-bot messaging (CAPTCHA, “访问异常/请验证/机器人”, 403/429, blank content without JS).
- The user needs **personalized** details (logged-in price, coupons, shipping, availability).

## Tooling rules (strict)

- Use `$ego-browser` directly for browsing and extracting data. Use one task-scoped Ego TaskSpace. Use `chrome:control-chrome` only when the user explicitly requests it or the requested data requires an existing Chrome session.
- Use `tvly-hikari` only for general discovery (e.g., finding an official product page), not for extracting behind-login details.
- Do not automate CAPTCHA solving, login, checkout, or other state-changing actions.

## Guardrails

- Do not attempt to bypass access controls or solve CAPTCHAs automatically; ask the user to complete verification manually in the active browser session.
- Keep collection scoped to what the user asked for; avoid bulk scraping.

## Setup prerequisite (authenticated session)

Use `$ego-browser` by default. When the task requires user-specific login state that is unavailable in its session, ask the user to authenticate through the selected browser surface.

If it is not available:

1. Ask the user to authenticate or complete the required site verification in the selected browser session.
2. Use `chrome:control-chrome` only when the task must access the user's existing Chrome session and the owner has explicitly authorized that exception.

## Workflow (human-in-the-loop)

1. Navigate to the target URL with `$ego-browser`.
2. If there is CAPTCHA / verification: pause and ask the user to complete it manually, then continue.
3. Extract required fields:
   - Item title/model
   - Price (and whether it includes coupons)
   - Shipping fee and destination assumptions
   - Store name
   - SKU/variant selection (if relevant)
   - URL and timestamp
4. Present results as structured bullets and include the local date/time explicitly.

## References (load only when needed)

- Detailed shopping-site workflow and heuristics: `references/data-collection.md`
