---
name: integrate-ramp-provider
description: Start here to add a new on/off-ramp provider (fiat↔crypto) to SDP. Routes you through the integration sequence and the non-negotiable rules; the individual steps live in their own skills. Use when opening a PR against apps/sdp-api to integrate a ramp or payment provider.
---

# Integrate a ramp provider

The umbrella. This ties the per-capability skills into one sequence. Read `apps/sdp-api/src/lib/ramps/providers/lightspark.ts` as the canonical example, then work the steps below.

## Inputs

- **`docs`** — your provider's API documentation URL (e.g. `docs: https://docs.yourprovider.com`). Pass it when you start; every step uses it as the source of truth for your endpoints, auth, and payload shapes when mapping your API onto SDP's contract. The closer your docs, the less guesswork.

## Sequence

Do them in this order; skip the flows you don't support.

1. **register-provider** — scaffold: add the id to `RAMP_PROVIDERS`, register the client, fill the dispatch switches, write the mode-keyed config reader + declare its env vars. Make it compile.
2. **rail-discovery** — declare which fiat/crypto rails you support.
3. **integrate-estimate** — rate preview; the cheapest live end-to-end check (no DB, no KYC).
4. **counterparty-requirements** — KYC gating for the flows.
5. **integrate-onramp** / **integrate-offramp** — the quote flow(s) for the direction(s) you support.
6. **integrate-webhook** — settlement events and reconciliation.

The type system is the checklist: adding the id in step 1 breaks compilation at every site a provider must be wired (the `as const satisfies Record<RampProviderId, …>` registry + the exhaustive `switch`/`never` defaults). Fix each — don't add a fallback to silence it.

## Rules that aren't optional (shared by every step)

- **No fallbacks.** No `?? default`, `|| []`, swallowed `try/catch`, or "shouldn't happen" guards. Required data is required — throw and fail loud.
- **HTTP in the provider; DB in the route handler.** Providers read creds from the passed `env` keyed by `mode` and never touch the database.
- **Secrets are environment variables**, mode-keyed (`<KEY>` and `<KEY>_SANDBOX`); a missing one throws `providerNotConfigured` → HTTP 503. (This repo injects them via Doppler in deploy, but your code just reads `env[...]` — supply them however your environment does.)
- **Webhooks are fully typed** — parse the raw body as `unknown` only at the signature boundary, then narrow.
- **Strong typing** — no `any`, no `enum`, finite sets are `as const satisfies Record<…>`.
- **Verify** with `tsc --noEmit` + `biome check` (ESLint is broken repo-wide — don't use it).

Per-step detail lives in each linked skill.
