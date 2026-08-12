# /v1/earn routes — agent notes

HTTP surface for SDP Earn. Provider-neutral: handlers resolve clients through
the fail-closed registry and check capabilities — no `if (provider === "ground")`
anywhere. See `packages/sdp-earn/README.md` for architecture; ADR 0002 for
invariants (the 2026-08-11 addendum owns the ledger-vs-live rules below).

## Route map — with each route's single source of truth

Every route reads exactly ONE source for the STATE it reports (DB or live
provider) and never blends them; that is an ADR 0002 addendum acceptance
criterion, not a style choice. The `earn_provider_wallets` row is the link
record, not state: a route may resolve which provider wallet a program is and
then read all of its money live — what it may never do is mix a persisted
balance with a live one.

- `GET /strategies[/:id]` — **DB** (synced catalogue), env-scoped. Written only
  by the sync cron + the local dev seed.

**Programs — N per (org, environment, provider) since PRO-1670**, each pinned to
one vault, nothing rebalancing across them; moving money between programs is
explicit (withdraw from one, deposit into the other). A program is addressed by
its OWN id — `mapProgram` puts `id` first in the envelope, and every
`/programs/:programId` route resolves it through `getProviderWalletById`, which
scopes to organization **and** environment (the old triple lookup made a guessed
id structurally impossible; an addressable id does not, so the scoping is
explicit). `provider` therefore appears ONLY on the create body and as a list
filter; every per-program route takes it from the stored row. The collection
routes are declared BEFORE the `:programId` ones so a literal segment can never
be captured as an id. Uniqueness moved to a GLOBAL `UNIQUE (provider,
provider_wallet_ref)` (migration 0056) — one link row may claim a provider wallet
platform-wide, because two orgs pointing at one wallet would each read the
other's balance.

- `GET /programs` — **DB list** (`earn_provider_wallets`) + a **live provider**
  wallet snapshot per row, `{programs, total, page, pageSize}`. Optional
  `provider` filter and page window. Ordered **oldest first** (`created_at ASC,
  id ASC` — `selectPage`'s `order` param, which every other list leaves at
  DESC): consumers that track one program across polls need a stable head, and
  under newest-first, creating a program would re-point them at a different
  wallet and let a stale busy snapshot meet a fresh ready one — announcing money
  that never moved (migration 0056's header). A page of N programs is 2N provider
  round trips (wallet + yield), issued in bounded waves
  (`LIST_LIVE_READ_CONCURRENCY` = 8) so a 100-row page cannot burst 200
  concurrent requests at the shared provider account; one failing read fails the
  whole list rather than silently omitting a program that holds funds.
  - **The credential gate runs even when the list is EMPTY** (when `provider` is
    given — an unfiltered list has no provider to check). Deliberate: the
    pre-PRO-1670 `GET /program` resolved the row first, so "no program AND no
    credentials" was a 404; a collection cannot 404 for emptiness, so without
    the assert a missing key would read as "this org has no programs" and the
    dashboard would show onboarding instead of its 503 notice.
- `POST /programs` — **explicit create**: provider call + row insert, then a
  live snapshot. **201** on a real create, **200** when the provider replayed
  (there is no `created` boolean on the wire any more — the status carries it).
  Body is `{provider, allocations, label?, requestId?}`.
  - **An idempotency key is REQUIRED**, exactly one of body `requestId` (UUIDv4)
    or the `Idempotency-Key` header — both and neither are 400s, same rule and
    same reasoning as the withdrawal path. Creation became key-required with
    PRO-1670: while one program per (org, environment, provider) was the cap, a
    DB unique caught a retried create; with N programs legal nothing downstream
    can tell a retry from a genuine second program, and an unkeyed retry
    provisions a duplicate wallet the customer may then fund.
  - The key is **derived, never forwarded**:
    `deriveProviderRequestId(["earn_program_create", organizationId,
    environment, provider], callerKey)` — the same triple whose unique used to
    catch the retry. Every org shares one provider account, so two orgs pasting
    the same placeholder UUID would otherwise land on one provider request and
    the second would be answered with a replay of the FIRST org's wallet.
    Deliberately NOT in scope: `projectId` (sibling projects share programs), the
    allocations, and the label.
  - **Gate ORDER is load-bearing — key resolution runs LAST.** parseBody
    (schema 400s) → `requirePortfolioClient` (501) → `assertProviderAvailable`
    (403) → `assertKnownYieldSources` (400) → project scope (500) → key
    resolution (400). An unentitled caller sending no key still gets 403, and a
    provider without the portfolio capability still gets 501, rather than a
    generic "missing idempotency key" that hides why the call could never work.
  - **A unique violation on the insert is a REPLAY, not a race.** The provider
    dedupes on the derived key and answers a retried create with the ORIGINAL
    wallet ref, so a legitimate retry lands on 0056's global unique by design:
    the handler re-reads via `getProviderWalletByRef` and, if the row is the
    same org AND environment, serves that program with 200. Answering 409 here
    would make the required key produce the very double-send it exists to
    prevent. A ref held by another org or environment should be unreachable
    given the key's scope; if it happens the provider handed us someone else's
    wallet, so it 409s (`"already linked to another account"`) rather than
    adopting it.
  - Default label when none is supplied:
    `sdp-earn-<org>-<env>-<derivedRequestId first 8>`. The suffix comes from the
    DERIVED key, not the row id: the label is part of the create payload, a row
    id only exists after the provider call, and a retry whose payload differed
    could turn a replay into a payload conflict.
  - `label` stays write-once — no repository update path, so the re-target body
    does not accept one.
- `PUT /programs/:programId` — **re-target this program's single vault in
  place**, body `{allocations, requestId?}` (no provider, no label). 200 with the
  live snapshot. Money-in, so it takes the full availability gate +
  `assertKnownYieldSources`. The idempotency key is OPTIONAL here — re-targeting
  moves no money and re-applying the same allocations is a provider no-op — but
  it accepts the same two sources as its siblings (body `requestId` or the
  `Idempotency-Key` header, both → 400): the platform middleware echoes the
  header on every response, so a route that silently dropped it would look
  keyed while minting a fresh provider id per attempt. When present the key
  derives against the wallet (`["earn_program_retarget", providerWalletRef]`),
  so one caller key used against two of the org's own programs cannot collapse
  into one provider mutation.
- **Allocations (create and re-target both).** Earn V1 is single-vault
  (PRO-1667): each token group accepts exactly ONE allocation entry, which the
  sum-to-100 rule then pins to `pct: 100` — one vault per deposit token per
  program. The weighted multi-entry validation (0.1 grid, sum to exactly 100,
  duplicate check) is dormant, not removed: the API side of re-enabling weights
  post-V1 is relaxing the group cap in `schemas.ts` — wire shape and provider
  contract need nothing. Relaxing it alone does NOT ship weights: the dashboard
  has no weight authoring or share display (removed by design), and the cap is
  what keeps the API from accepting portfolios the dashboard cannot manage until
  that work returns. Concurrent exposure to several strategies is what the
  *programs* are for. Every `yieldSourceId` must exist as an **active** synced
  strategy for that provider+environment.
- `GET /programs/:programId` — **live provider** snapshot (+ best-effort yield);
  balances/positions/yield are never persisted. A miss is 404 in every case — a
  foreign org's id, a sandbox id presented by a production session, and a typo
  are indistinguishable to the caller on purpose.
- `GET /programs/:programId/deposits` — **live provider** (provider-observed
  on-chain deposits; cursor passthrough). Deposits are customer-initiated, so SDP
  never sees them at intent time — they are deliberately NOT ledgered in V1.
- `POST /programs/:programId/withdrawal-preview` — **live provider**.
- **`POST /programs/:programId/withdrawals` — live provider call + SDP ledger
  write.**
  Needs a retry-stable idempotency key and refuses a request carrying none:
  EXACTLY one of `requestId` (UUIDv4) or the `Idempotency-Key` header — both
  and neither are 400s, because no precedence rule can tell which of two
  sources a caller's retry keeps stable, and following the wrong one pays out
  twice. `deriveProviderRequestId` hashes the key into a stable id scoped by
  the program wallet (two tenants sharing the provider account cannot collide;
  Ground validates the shape strictly — v4 only, verified 2026-08-05).
  Since PRO-1628 the defence is TWO-layer: the derived id anchors an SDP
  intent row in `earn_program_withdrawals` — unique per (wallet, request_id),
  wallet-scoped because sibling projects reach the same program and, since
  PRO-1670, because one caller key used against two of the org's own programs
  must not collapse into one payout — with a payload
  fingerprint that answers a replay from our own ledger (200, live state) and
  409s key-reuse-with-different-payload BEFORE any provider call. The
  provider's own request-id dedupe closes the crash window between our insert
  and its acceptance. A ledger write that fails AFTER provider acceptance
  never fails the response (money moved): it retries, then logs
  `earn_ledger_write_failed`. Heal semantics are narrow: the detail poll heals
  only rows that already carry `provider_reference`; a ref-less row heals via
  a same-key retry or the ledger sweep — never fuzzy matching. NOTE for the
  sweep (hard requirement, from review): a ref-less `requested` row can also
  be a definitively-rejected intent (provider 4xx rethrows and leaves the row
  untouched) — the sweep must discriminate or verify with the provider before
  re-driving, or it could execute an intent the caller abandoned.
- `GET /programs/:programId/withdrawals/:withdrawalRef` — **live provider**, and
  persist-on-observation: the response is always the provider's live object; the
  matching ledger row (found via the global (provider, provider_reference)
  unique) is advanced best-effort as a side effect. Unknown refs serve live state
  and touch nothing (pre-ledger withdrawals must keep polling fine). A **BOLA
  guard** runs before the provider call, and since PRO-1670 it compares the
  **program, not the organization**: `ledgerRow.wallet_id !== row.id` 404s. An
  org-only check was complete while an org held one program; with several,
  asking program A for program B's ref would pass it and then drive the provider
  with A's wallet ref and B's withdrawal ref — a mismatch whose answer is
  entirely the provider's to decide. wallet_id is strictly stronger and still
  lets an unknown ref fall through. Cross-tenant scoping stays SDP's job, never
  delegated to the provider's own path scoping.
- `GET /programs/:programId/withdrawals` — **DB ledger list**
  (`earn_program_withdrawals`), the house `{withdrawals, total, page, pageSize}`
  envelope, newest first. Scoped to the path program's `wallet_id`: every project
  in the environment reaches the same programs, so one program = one history, and
  with several programs the wallet id is also what keeps a sibling program's
  payouts out of this list. Note it resolves the program WITHOUT
  `requirePortfolioClient` and takes NO provider gate — not even the credential
  check — because the audit trail must outlive credential removal, entitlement
  disablement, and a provider losing its registry entry entirely. There is no
  provider query param left to registry-gate; the provider comes from the row.
- The status machine + appliers live in
  `services/earn-withdrawal-ledger.service.ts` (Hono-free on purpose: the
  ledger sweep job and future webhooks consume it too). Terminal set is the
  shared `EARN_TERMINAL_WITHDRAWAL_STATUSES` in `@sdp/types` — also consumed
  by the dashboard's outcome polling; never redeclare it.
- Removed by PRO-1628 (do not resurrect without a new decision):
  `GET /positions|/movements` (empty ledgers nothing wrote),
  `POST /deposits/quote|/withdrawals/quote` (501 for every provider — no
  provider ever implemented per-strategy quoting), and
  `GET /strategies/:id/nav` (no writer, no reachable reader). A regression
  test in `../earn.test.ts` pins all of them at 404.

## Gate asymmetry — DO NOT BREAK (ADR 0002 exit-safety)

- **Money-in** (`POST /programs`, `PUT /programs/:programId`):
  `assertProviderAvailable` (entitlement + enablement + credentials).
- **Money-out and live reads** (withdrawals create/detail, previews, program
  get, programs list, deposits list): `assertEarnProviderConfigured` ONLY — a
  disabled provider must never trap funds. The list resolves capability +
  credentials ONCE per distinct provider among the listed rows — before any
  live read, so a de-registered or vault-only provider fails the list with a
  clean 503/501 instead of mid-fan-out — and once more up front for a
  `provider` filter so an empty list still 503s (see route map).
- **The ledger list**: no provider gate at all (see route map).
- Route tests in `../earn-program.test.ts` encode the asymmetry: the money-in
  half (create and re-target both refused when the organization is not entitled
  or credentials are missing) and the money-out half (the "withdrawals (ADR 0002
  exit safety)" describe, plus the credentials-absent ledger-list case). The
  per-strategy quote exit-safety tests left with the quotes surface.
- Money-in also has an ORDER contract, not just a gate: `POST /programs`
  resolves the idempotency key LAST, so the entitlement 403 and the capability
  501 both win over the missing-key 400. Keep that pinned by a test — it is the
  difference between an actionable error and one that hides why the call could
  never work.

## Conventions

- Environment resolution is the shared `@/lib/sdp-environment` helper: API-key
  callers use the key's (project-derived) environment; dashboard/session
  callers use the membership-verified `x-project-id` project's environment; a
  request with neither fails closed (500), never defaults to sandbox. A
  production-project dashboard session therefore drives provider production.
- `EARN_ENABLED` gates the whole family (index.ts), and Earn is a sub-module of
  Markets — `isEarnEnabled` also requires the parent `MARKETS_ENABLED`, so
  clearing that one flag darkens every Markets API surface. Both default off.
  Never re-check Markets in a handler; the hierarchy lives in `isEarnEnabled`.
- Zod schemas in schemas.ts; parse/paginate/envelope helpers in
  handlers/shared.ts — don't hand-roll either.
- Capability gating: `supportsPortfolioWallets(client)` → NOT_IMPLEMENTED for
  providers lacking the surface.
- Withdrawal approval is a SECOND optional capability
  (`supportsWithdrawalApprovals`) with **no public route on purpose**: casting
  a vote needs the account-level Turnkey signer (platform ops — one shared
  Ground account per environment), so exposing list/request/vote under
  `/v1/earn` would hand org API keys an approval surface they must never
  hold. Orgs see a parked withdrawal as `status: pending_approval` on
  `GET /programs/:programId/withdrawals/:withdrawalRef` (derived by the provider client from payout
  legs; approval is policy-conditional, not default — see
  `packages/sdp-earn/README.md` → "Withdrawals unwind in reverse").
- Provider ids from DB rows are open strings — always dispatch via
  `resolveEarnProviderClient`.
- Catalogue writes happen ONLY via the sync cron
  (`src/cron/earn-catalogue-sync.ts` — the production path) and the dev seed
  (`db:seed:earn` — local only, refuses non-local databases). Cadence, failure
  behaviour, and which to use: `packages/sdp-earn/README.md` → "Catalogue data".
- Whole-stack local setup (ports, flags, Ground key, entitlement, troubleshooting):
  `packages/sdp-earn/CLAUDE.md` → "Local development".
- Tests: vitest; stub `EARN_PROVIDER_CLIENTS.<id>` methods with `vi.spyOn`;
  repository tests use testcontainers. The ledger repository/service suites in
  `../../db/repositories/earn.repository.test.ts` run against a NON-Ground
  stub id on purpose — the ledger consumes only the canonical contract, and
  that suite is the pluggability proof.
