# ADR 0005: Release channels

- **Status:** Proposed
- **Date:** 2026-10-02
- **Deciders:** SDP engineering
- **Related:** `packages/sdp-types/src/release-channels.ts`; `apps/sdp-api/src/lib/feature-flags.ts`; `apps/sdp-web/src/flags/release-channel.ts`

## Context

Deployments need to run different subsets of SDP modules. Module flags are set
individually per environment, in Terraform for the API and in Doppler/Vercel
for the dashboard. Issuance, Policies and Ramps have no module-level API
flag: their dashboard flags hide the UI, but the API still serves their routes.

## Decision

`SDP_RELEASE_CHANNEL` selects a release channel: the set of modules a
deployment can run.

- A module outside the release channel is disabled in the API, background jobs
  and dashboard, regardless of its flag. Inside it, module flags apply as before.
- Each module has a maturity in code (`SDP_MODULE_MATURITY`). A release
  channel runs every module at or above its own level, so each channel contains
  the more mature ones. A test pins each channel's module list.
- Ramps has no maturity of its own. Each ramp provider has one
  (`SDP_RAMP_PROVIDER_MATURITY`), and Ramps is in a release channel when at least
  one provider is, so providers launch one at a time.
- Markets has no maturity of its own either: it is in a release channel when Earn
  or DvP is, so promoting one sub-module always takes effect.
- Every deployment must set it: a missing or unknown release channel fails at
  startup in the API, its jobs and the dashboard server. Builds do not read it.
  Names are lowercase and case-sensitive.

| Release channel | Modules                                           | Target deployment                            |
| --------------- | ------------------------------------------------- | -------------------------------------------- |
| `stable`        | Custody, Payments, Recurring payments, Compliance | Production, stage                            |
| `beta`          | `stable` plus modules in final validation         | None yet                                     |
| `experimental`  | All modules                                       | Development, previews, self-hosted           |

Every deployment starts on `experimental`, which matches the behavior before
release channels. Stage and production move to `beta` and `stable` in a later
infrastructure change.

**Amended 2026-10-23:** stage runs `stable` too. It is the gate every prod
promotion passes, so it runs what prod runs; on `beta` it checked a superset of
production's configuration. No deployment runs `beta` until a dedicated beta
environment exists (HOO-2264); dev's `experimental` covers modules in
validation meanwhile.

A module or ramp provider is promoted by changing its maturity: `experimental` to
`beta` while it is validated (on dev until a beta deployment exists), then
`beta` to `stable` to ship it to stage and production. Maturity levels live on `main` and every deployment runs the same code, so
the release channel is what keeps a module under validation on stage out of
production.

Release channel names describe maturity rather than network, because one
deployment serves both devnet and mainnet projects. They also avoid
environment names: `dev` and `stage` already name SDP environments, so
`SDP_RELEASE_CHANNEL=dev` on production would read as a dev box. `preview`
already names the beta API (api-preview.solana.com), and `edge` and `canary`
already have other meanings in this repository. "Release channel" follows Rust
and Chrome; "edition" usually names a commercial tier, and "channel" alone
already names the Private Channels module.

## Consequences

- Each module needs an API gate. A route inventory test requires every API route
  to belong to a module or to core.
- Lists that span modules leave out excluded ones: `GET /v1/transactions` drops
  their rows, and an excluded ramp provider's transfers, and refuses a filter
  that names an excluded module.
- Code for excluded modules still ships in the image.
- Excluding a module also stops its exits: routes, webhooks and reconcilers for
  money already in flight (for example Earn withdrawals, DvP settlement, a ramp
  provider's payouts). Before a module or provider that has held customer funds
  leaves a channel, its open positions must be settled. Earn's vault-movement
  reconcilers are not gated (ADR 0002).
- When Issuance is excluded, token metadata (`metadata.json`) is not served,
  including for tokens issued earlier.
- The Policies module existed when this decision was written and was removed by
  ADR 0006. A key's grants (HOO-2099) name actions of every channel's modules,
  and the dashboard offers only the channel's; they are not a
  module.
- Compliance integrations in the dashboard show whenever the channel runs the
  Compliance module (ADR 0006). The screening API is available in every
  channel.
- The Transactions tabs follow each module's dashboard flag, but `GET
  /v1/transactions` filters only by permission and release channel. So a module
  inside the channel with its flag off has no tab, yet its rows still appear
  under "All" (HOO-1951).
- The dashboard hides excluded modules, but a Vercel Toolbar flag override can
  still show their UI to team members. The API refuses their routes either way.
