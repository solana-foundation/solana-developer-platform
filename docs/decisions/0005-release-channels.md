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
- Each module has a maturity stage in code (`SDP_MODULE_STAGES`). A release
  channel runs every module at or above its own level, so each channel contains
  the more mature ones. A test pins the `stable` module list.
- Ramps has no stage of its own. Each ramp provider has one
  (`SDP_RAMP_PROVIDER_STAGES`), and Ramps is in a release channel when at least
  one provider is, so providers launch one at a time.
- An unknown release channel fails at startup. Names are lowercase and
  case-sensitive. Managed production must set it explicitly.

| Release channel | Modules                                           | Target deployment                            |
| --------------- | ------------------------------------------------- | -------------------------------------------- |
| `stable`        | Custody, Payments, Recurring payments, Compliance | Production                                   |
| `beta`          | `stable` plus modules in final validation         | Stage                                        |
| `experimental`  | All modules                                       | Development, previews, self-hosted (default) |

Every deployment starts on `experimental`, which matches the behavior before
release channels. Stage and production move to `beta` and `stable` in a later
infrastructure change.

A module or ramp provider is promoted by changing its stage: `experimental` to
`beta` to validate it on stage, then `beta` to `stable` to ship it to
production. Stages live on `main` and every deployment runs the same code, so
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
- Code for excluded modules still ships in the image.
- Excluding a module also stops its exits: routes, webhooks and reconcilers for
  money already in flight (for example Earn withdrawals, DvP settlement, a ramp
  provider's payouts). Before a module or provider that has held customer funds
  leaves a channel, its open positions must be settled. Earn's vault-movement
  reconcilers are not gated (ADR 0002).
- When Issuance is excluded, token metadata (`metadata.json`) is not served,
  including for tokens issued earlier.
- When Policies is excluded, policy configuration is refused and policy
  evaluation is skipped, so per-key spend caps, wallet rules and approvals do
  not apply. API-key wallet bindings are still enforced. Existing rules are kept
  and apply again when Policies returns. Each skipped evaluation is recorded
  with its own reason code, and refused operations stay in the operation ledger.
- Compliance integrations in the dashboard still follow the `policies` flag, so
  they are hidden under `stable` until Compliance gets its own visibility rule.
  The screening API is available in every channel.
- The dashboard hides excluded modules, but a Vercel Toolbar flag override can
  still show their UI to team members. The API refuses their routes either way.
