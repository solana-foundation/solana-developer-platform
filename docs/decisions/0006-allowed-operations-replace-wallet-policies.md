# ADR 0006: Allowed operations replace wallet policies

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** SDP engineering (HOO-1889)
- **Related:** `CONTEXT.md`; `packages/sdp-types/src/api-keys.ts`;
  `apps/sdp-api/src/routes/api-keys/`; `docs/decisions/0005-release-channels.md`

## Context

SDP had a custody policy engine, `@sdp/policy`. It had two kinds of policy:

- A **Wallet Policy** on a custody source wallet. It could allow, deny, or hold
  an operation for approval, whoever started it.
- An **API Key Policy**, stored as control profiles with revisions and bound to
  each key-and-wallet pair. It could narrow what the key did or route it to
  approval.

Both used the same rule kinds: operation family, operation type, asset,
destination allowlist, amount cap and velocity cap. A hold created an
**Approval Request**, answered in a dashboard inbox and replayed by a cron job.
Every decision wrote a **Policy Evaluation** row. Every gated call wrote a
**Wallet Operation** ledger row, and a `Dry-Run` header returned the decision
without executing.

The engine sat in front of about twenty-five value-moving routes in payments,
ramps, issuance, Earn and DvP, and inside the Helius Rings and recurring
payment services. Earn and recurring payments also used the ledger for
idempotency. The `policies` module was experimental only, so no stable or beta
deployment ever enforced it, and no customer relied on it.

Ahead of a security audit, we want fewer code paths on every value-moving
route, and a control model a reviewer can hold in their head.

## Decision

Remove the policy engine and keep one small per-key control.

- Wallet Policy, Policy Evaluation, Approval Request, Provider Control Mapping,
  the Wallet Operation ledger and envelope, the `Dry-Run` header, the approval
  replay cron, the `policies` module and `@sdp/policy` are removed. There is no
  hold state: an operation is allowed or refused.
- API Key Policy is replaced by **Allowed Operations**: one list on the API key
  of the operation families and types it may perform. An empty or missing list
  places no restriction. An operation not in a non-empty list is refused with
  an error, like a missing permission. Nothing is stored on refusal.
- Allowed Operations are checked once, when the request arrives, by a static
  declaration on each value-moving route. They apply to API keys only. A
  dashboard session is not an API key. Background runs started by an earlier
  request, such as a recurring collection, do not re-check them.
- The operation vocabulary keeps the existing type names and all family names
  but one: the Helius Rings family is `privacy`, not the policy engine's
  `transfer`, because ordinary transfers belong to `payment` and a key listing
  `transfer` would expect them. Actions that were deliberately never gated, such as DvP cancel and reclaim, stay
  ungated: a control must never strand funds.
- Allowed Operations ship in every release channel. Existing control profiles
  are not converted; every key starts unrestricted.
- Wallet access stays as it is: `walletScope` and `signingWalletIds`, backed by
  `api_key_wallet_permissions`.
- The work lands as a stack. First the API adds Allowed Operations. Then the
  dashboard swaps its policy UI for one simple step and deletes the policy and
  approvals pages. Then the API deletes the engine and regenerates every
  derived artifact. The eleven policy tables are dropped in a final change
  only after the removal has served production traffic, because a production
  rollback redeploys the previous image without running migrations.

## Consequences

- A Wallet Operation is gated by authentication, permissions, the key's wallet
  binding, its Allowed Operations and the release channel. Nothing else.
- The `SIGNING_PENDING` 202 response disappears from transfers, batches,
  ramps, Earn and DvP. Clients that handled it have nothing to wait for.
- Amount, asset, destination and velocity controls no longer exist in SDP.
  Customers who need them use their custody provider's native controls.
- Earn's duplicate-request detection moves onto Earn's own tables, which
  already carry an idempotency fingerprint and lock. The recurring payments
  pending-approval check is deleted. Helius Rings loses its
  `approval_required` state and `policy_denied` and `approval_rejected` codes.
- The dashboard's Compliance catalog no longer borrows the `policies` flag and
  gets its own visibility rule: shown when its module is in the release
  channel.
- The public API loses the `policies` family, the five wallet-policy
  endpoints, the four API key profile and binding endpoints, and the five
  approval-request endpoints, with no deprecation period. No customer used
  them.
- Refusals are not recorded. If operators later want a history, one audit
  ledger row per refusal is a small follow-up with no schema change.
- Between the removal deploy and the table drop, the policy tables exist but
  nothing reads or writes them.

## Alternatives considered

- **Keep API Key Policy with approvals, drop only Wallet Policy.** Rejected:
  it keeps the engine, the ledger, the inbox and the cron alive for a feature
  no one could author at wallet level.
- **Permissions only, no per-key operation list.** Rejected: permission scopes
  such as `payments:write` are coarser than the per-action rights a key owner
  wants to grant, and widening the scope list for every action would make
  roles unreadable.
- **Convert existing rules into Allowed Operations.** Rejected: no production
  key carries a policy, so a conversion would be code with nothing to convert.
- **Drop the tables in the same change.** Rejected: the production rollback
  path redeploys the previous image without migrations, and that image writes
  the ledger on every gated call.
