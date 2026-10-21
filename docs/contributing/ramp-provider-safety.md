# Ramp provider safety requirements

Apply this checklist to every new fiat ramp provider and every change to its
quote, webhook, deposit, or reconciliation path. ADR 0008 defines the provider
contract; this document defines the money movement acceptance gate.

## Before implementation

1. Record the provider's current API and webhook documentation, supported
   Solana rails, sandbox limitations, signature scheme, event ordering field,
   transaction identifier, and status meanings. Obtain sanitized sandbox
   examples for successive statuses in both supported directions.
2. Record how SDP looks a transfer up without a webhook: the endpoint that
   finds the provider's transactions by SDP's own reference, what it answers
   when it holds none, and how long an abandoned checkout stays open on the
   provider's side. A provider with no such lookup cannot launch: a lost
   webhook would leave its transfers open forever.
3. Write a change-level threat model: untrusted provider claims, wrong tenant
   or environment, wrong asset or destination, replay, reordering, concurrent
   cancellation, provider outage, chain RPC outage, and a crash after an
   external action. State how each case recovers without a second money move.
4. Keep each quoted source amount, fiat currency, asset mint, wallet, and
   destination immutable. Name provider-reported amounts by their actual unit
   and direction. Store observations separately; compare crypto to crypto and
   fiat to fiat. Never infer delivery from a price or fiat amount.

## Settlement and recovery

- Verify webhook signatures over the raw body, including provider-signed time
  when available. Persist before acknowledging; replay the same durable event
  through the same typed parser and guarded settlement path.
- Correlate by the provider reference bound to the transfer, then check the
  project environment, ramp direction, delivered asset, and quote. Use the
  provider's per-transaction ordering field when supplied. Refuse ambiguous
  matches; never guess a transfer from an amount, address, or customer id.
- Provider `settled` means `settling`. Save its reference, reported economics,
  transaction signature, and addresses as observations. Do not copy them over
  quoted terms or mark the transfer `completed`. Queue even a settled event
  without a signature for review; accept later signed evidence through a
  guarded update. A newer, ordered non-settled observation clears the settlement
  claim. An event without a per-transaction ordering field cannot clear an
  accepted claim; hold contradictory states for reconciliation.
- A cluster-scoped verifier alone writes `completed`: an on-ramp needs a
  finalized successful transaction with the quoted mint and destination's
  received amount; an off-ramp needs the row's own SDP-signed deposit signature
  finalized and the provider's settled observation. Batch off-ramp signature
  reads once per sweep and use one transaction read per on-ramp. Guard the
  final write against a changed provider observation or signature. Record the
  verified chain amount separately when it differs from the quoted amount.
- An off-ramp's fiat payout remains a provider attestation. Reconcile its
  payout status and destination with provider records; park discrepancies for
  operator review. Chain finality proves the crypto deposit, not a bank credit.
- Keep unknown, mismatched, failed, or unavailable chain evidence in
  `settling` for retry and operator review. Retry what is unknown or
  unavailable; hold a finalized contradiction (`deliveryMismatch`) until the
  provider reports again, rather than re-reading it. Do not treat a missing
  signature, RPC timeout, provider timeout, or generic error as proof that no
  money moved. Never release a once-only claim unless the provider definitely
  rejected it, or SDP holds no signed bytes for it (an off-ramp deposit that
  failed before signing returns to `awaiting_payment`, unless the provider
  failed the sale during the claim: then it fails).
- Recover missed webhooks by pulling. `fetchTransferStatus` makes one request
  per transfer, maps the answer through the same package mapping as the
  webhook parser, and returns no events only when the provider holds no
  transaction. The status sweep applies each event through the provider's
  webhook processor. A failed pull or a refused event is never absence.
- SDP expires a checkout itself, from `pending` or `awaiting_payment` only,
  once the provider's abandonment horizon passes with no provider activity,
  and only while the row is unchanged since the sweep read it. A provider
  status the mapping does not know (`unmappedStatus`) holds the transfer for
  review instead. An expired off-ramp withdraws its deposit instruction. Only provider progress revives an
  expired transfer, so a provider's repeated "not paid yet" without an
  ordering field never counts as activity.
- Keep retries idempotent and bounded. A worker that reads the chain runs per
  environment on its matching cluster; a worker that only calls provider APIs
  runs once and resolves each row's environment. Both continue when a release
  channel hides a provider's public API family, so its transfers still finish.

## Evidence before review

- Exercise signed sandbox webhooks and replay for each status, duplicates,
  reordering, wrong environment, wrong asset, wrong destination, canceled rows,
  and a provider outage. Save sanitized evidence in the PR.
- Test chain verification with finalized, pending, failed, missing, wrong mint,
  wrong owner, short amount, conflicting provider observation, and a concurrent
  status change. Pin the RPC request count for each sweep.
- Run the status pull against the sandbox: a known transaction in each
  supported direction, a transfer the provider holds nothing for, and a
  provider error. Record the provider's empty answer in the contract kit and
  pin one request per lookup.
- Run focused API and provider tests, typecheck, lint, and applicable CI.
  Record checks that could not run. This is a Critical fund movement change:
  obtain standard code review and internal security review before release.
