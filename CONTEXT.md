# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment.
_Avoid_: Runtime health, selected provider, project setup

**Dashboard Warm Snapshot**:
A bounded-stale, organization/project-scoped bundled read snapshot used to make dashboard module roots render immediately while fresh data revalidates in the background.
_Avoid_: Authoritative state, materialized view, live balance

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Dashboard Warm Snapshot** bundles wallet summaries, aggregate balance, issued tokens including drafts/pending tokens, and API keys for one **Organization** and optional **Project**.
- A **Dashboard Warm Snapshot** is bounded-stale and must be revalidated before it becomes authoritative for mutations or compliance-sensitive actions.
- Dashboard module roots may render from a **Dashboard Warm Snapshot** before fresh reads complete; detail pages and mutation flows may require stricter freshness.
- Aggregate balance in a **Dashboard Warm Snapshot** is allowed to be stale, refreshing, or temporarily unavailable rather than blocking module-root first paint on live chain balance reads.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."
>
> **Dev:** "Can the wallets page render from the **Dashboard Warm Snapshot**?"
> **Domain expert:** "Yes, as long as it revalidates immediately and write actions invalidate or update the snapshot."
>
> **Dev:** "Should sidebar navigation wait for fresh wallet, token, balance, and API key fetches?"
> **Domain expert:** "No — module roots should feel SPA-fast and hydrate from the warm snapshot while they revalidate."
>
> **Dev:** "Should the **Dashboard Warm Snapshot** wait on live aggregate balance reads?"
> **Domain expert:** "No — return a stale or refreshing aggregate balance if needed, then revalidate it after first paint."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
- "Preload" can mean server-side blocking fetch, browser prefetch, persisted client cache, or database pre-aggregation; resolved: **Dashboard Warm Snapshot** means bounded-stale first paint with background revalidation.
- "Fast page load" can mean server-rendered fresh data or SPA-style client hydration; resolved: dashboard module roots prioritize SPA-fast first paint from **Dashboard Warm Snapshot**.
