# Earn intent recovery and API consistency

Date: 2026-10-01. Implementation proposed on `codex/earn-hardening`; release review pending.

Earn Treasury and Embedded Yield share the signed movement ledger. A new user
instruction must produce a new intent even when its wallet, strategy and amount
match the previous one. A retry after an uncertain response must recover the
original intent. Neither elapsed time nor the HTTP status of a later attempt
can distinguish these cases.

The custody wallet, partner signer, provider contracts, RPC observations, database
and browser are separate trust boundaries. This change is Critical tier: mistakes
at these boundaries can duplicate transfers, strand tracking, or misstate balances.

## Decisions

- The Treasury browser pins a key durably before posting, including queued
  requests and cancellations. Only unsubmitted drafts expire. A parsed durable
  acknowledgment releases the key; the next intentional transfer may have the
  same terms. An uncertain or approval-held attempt survives later 4xx responses.
  Explicit same-key terminal policy denial permits a new intent.
- If session storage refuses that pin (blocked or full), the dashboard does not
  send the Earn request and asks the user to enable browser storage. A memory-only
  key dies on reload, so a retry after a lost response would mint a fresh key and
  could move the funds twice. This fail-closed rule replaces the previous fail-soft
  contract; Private Channels still fail soft.
- If a direct-allow custody handler throws before durable intent exists, a
  conditional database update marks only its own evaluated wallet operation
  failed and clears its reserved key. The failed operation remains auditable
  and does not consume velocity limits. Recorded movements, queued intents,
  approval requests and execution fences prevent cleanup. Provider-managed
  program withdrawals cannot use this recovery path.
- The standalone example prepares and signs separately from submitting. It
  stores the exact signed envelope before broadcast, serializes access with
  Web Locks, and resumes it after reload. The submit endpoint never signs or
  rebuilds. Invalid responses and transport/authentication failures retain the
  envelope. A fresh acknowledged operation can be followed by another with
  identical terms.
- Authenticated external submits verify the stored message and signatures before
  recording signed intent, including expired builds. An owner may already have
  broadcast independently. The original signed bytes and signature remain
  available for reconciliation; expiry is not a reason to request a new signature.
- A processed or confirmed RPC error cannot fail a requested/submitted movement.
  Finalized execution errors can. Missing provider history and closed requests
  continue to mean unknown unless authenticated final evidence resolves them.
- Observed payouts are identified by durable withdrawal request, not a command
  idempotency key or solver transaction signature. Migration 0123 permits null
  command keys only for observed payouts and normalizes previous writers with a
  trigger. It preserves initiated-movement indexes and historical economic data.
- Executing provider read/build calls can retry transient failures against the
  configured default-cluster pool. Every endpoint must independently prove its
  genesis hash. Explicit cluster pins stay isolated. Cursors are per operation,
  never sticky across later historical reads, and all attempts share one deadline.
  Signing/broadcast and reconciliation retain their existing durable recovery
  rules; this runner does not retry those effects.
- Internal OpenAPI covers the actual mounted Earn operations. Custody request
  schemas are reused from runtime validation; core response schemas are shared
  with the Treasury UI. Public Earn publication remains disabled under PRO-2038.
  Unknown values remain absent, and shares, token amounts and USD are distinct.

## Evidence and rollout

Regression coverage includes same-key retries, three sequential identical-term
intents, lost HTTP responses and reload, storage refusal, later authorization
failure, pre-intent policy failure, in-flight ownership, recorded-intent protection,
nonfinal chain errors, expired signed submissions, payout key collisions and
migration replay, genesis-checked fallback, and runtime/OpenAPI route parity.
Existing provider receipt, rounding, authorization, settlement, valuation and UI
state suites remain part of validation. Mocks model transport and signing seams;
Postgres repository tests exercise the real constraints and transactions.

Apply 0123 before the new payout writer. Rollback keeps the expanded schema:
older writers are handled by the trigger, and initiated commands still use the
same constraints. There is no production backfill or infrastructure change.

These tests do not certify provider solvency, liquidity, issuer fulfillment,
RPC truthfulness or custody availability. Browser storage can be cleared and
Treasury session storage is per tab; production partner integrations should keep
an authenticated server-side intent journal for cross-device recovery. The
example's signed envelope is readable by scripts on its origin, so access and
same-origin protections remain essential. Independent security review, CODEOWNERS
review, exact-head CI and a controlled staging/live-provider exercise remain
release gates. No zero-loss guarantee follows from passing local tests.

Treasury keeps atomic confirmation as Done and requests wallet and position
balances with a common confirmation bound. The positions API authorizes every
requested movement before resolving confirmed signature slots. Request-local RPC
contexts enforce each affected position's maximum slot, and each page
acknowledges the bound. Wallet reads then enforce that same minimum slot. A late
HTTP response alone cannot clear the updating state. Partial RPC failure is
absent from the API, never a cached or fabricated zero balance. The UI retains
explicitly labelled last verified values for unaffected holdings, excluding them
from current totals. One Treasury coordinator gates affected amounts from before
submission through confirmation and the paired refresh. Subsequent polling keeps
the bound; execution and reconciliation keep their existing commitments. It does not project requested amounts into
holdings or availability. The bank example also separates requested amounts
from observed payouts and excludes queue quotes from current value and earnings.
Provider-order confirmation stays pending; the external-wallet movement contract
now explicitly identifies atomic versus provider-order settlement.


A devnet read reproduced a response-shape regression in Veda: adding RPC context
changed `getProgramAccounts` from an array to an envelope, breaking the SDK's
`listAssets().filter` path. The shared transport now verifies the bank slot and
then restores the caller's requested shape. Live public-fixture reads passed
with the fix; regressions cover kit and JSON transports, stale-slot rejection,
and isolation of same-provider and cross-provider holdings. Embedded Yield uses
the same provider transports, so the repair does not depend on the Treasury UI.
