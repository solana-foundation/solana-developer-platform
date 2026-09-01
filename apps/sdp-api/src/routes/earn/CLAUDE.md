# /v1/earn routes — agent notes

HTTP surface for SDP Earn. Provider-neutral: handlers resolve clients through
the fail-closed registry and check capabilities — no `if (provider === "ground")`
anywhere. See `packages/sdp-earn/README.md` for architecture; ADR 0002 for
invariants (the 2026-08-11 addendum owns the ledger-vs-live rules below).

## The unified movement ledger (PRO-1705)

`earn_movements` is the single authoritative record of every Earn money movement —
both directions, both execution models — and `earn_positions` is the single
holdings table behind it. Migrations `0062`-`0065`; ADR 0002's 2026-08-19 addendum
holds the decisions.

The tables it replaced (`earn_program_withdrawals`, `earn_vault_movements`,
`earn_vault_positions`) are gone, dropped by `0068` along with the
`earn_projected_*` views that carried their history across.
**`earn_provider_wallets` is NOT one of them**: it models an ACCOUNT at a provider
— the custodial twin of `custody_wallets` — and an account is not a holding. A
custodial position is the link row between the two, minted when the program wallet
is linked.

Things worth knowing before changing a movement path:

- **One writer, and the shared matrix owns the transitions.** Legal source states
  come from `EARN_MOVEMENT_TRANSITIONS` (`@sdp/types`), never from the caller, so
  terminal regression is unrepresentable rather than merely refused. A transition
  whose row is not in a legal source state returns NULL — the same answer a lost
  race gives, and the same contract every other guarded write here has. Only an
  unknown TARGET throws.
- **Every movement needs a holding, and a missing one must never fail a money
  write.** `createCustodialMovement` resolves the holding by JOIN — so a movement
  can never name one outside its program — and OPENS one if the program has none,
  retrying once before giving up. A program linked by a revision that predates
  the ledger has no holding through no fault of the caller, and refusing would
  take that program's whole withdrawal endpoint down until an operator
  intervened. It still fails loudly when the program wallet itself does not
  exist, because the alternative there is money moving unrecorded.
- **Amounts carry a `denomination`** (`usd`, or the token mint) and share counts
  live only in share-named columns. No read may sum across rows without grouping
  by it.
- **`confirmed` is not terminal** (PRO-1716). The reconciliation sweep keeps
  polling a confirmed movement until the chain says `finalized`, and a confirmed
  row whose signature has aged out of RPC history is left alone rather than
  expired — the transaction demonstrably landed, and the blockhash rule only ever
  applied to one that never made it on chain.
- **The published vault-deposit DTO still speaks the older vocabulary**, through
  `LEGACY_VAULT_DEPOSIT_STATUS` in `handlers/vault.ts`: `requested` goes out as
  `pending`, and `finalized` as `confirmed`. `?settled=` matches that same
  client-visible notion. Delete both when the DTO adopts the ledger vocabulary.
  `GET /v1/earn/movements` is the one read that speaks the ledger's own words.
- **Ids are heterogeneous by design.** New rows are `earn_movement_…`, while
  history keeps the `earn_vault_movement_…` / `earn_program_withdrawal_…` ids the
  projection preserved. Nothing may parse an id for its kind — read
  `execution_model` — and the keyset cursors validate SHAPE rather than a prefix
  for the same reason.
- The vocabulary tables `earn_execution_models`, `earn_movement_directions` and
  `earn_movement_statuses` are seeded reference data, pinned to `@sdp/types` by a
  conformance test. Never truncate them in a test fixture.
- `EARN_MOVEMENT_TRANSITIONS` is written to agree with `0062`'s CHECK
  constraints, not merely with itself. In particular there is no
  `confirmed → failed`: the schema ties `confirmed_at` and `shares_out` to the
  commitment states, so recording that transition could only succeed by erasing
  observations SDP genuinely made. A confirmed transaction dropped by a fork
  stays in the reconciliation queue as an open question. Do not add the
  transition without changing the constraint it contradicts.
- `0064` established history but does NOT converge rows a legacy-only writer
  ADVANCED during a rollout or rollback window — `ON CONFLICT DO NOTHING` leaves
  the stale projection, and neither applier revisits a terminal row. `0065` is
  the same projection re-stated as a guarded upsert, and it is where the
  convergence guarantee actually lives. Read both headers before assuming a
  backfill is self-correcting.

## Route map — with each route's single source of truth

`GET /movements` is the cross-provider feed over `earn_movements`: one
chronological history spanning both execution models, which no per-family list can
serve. It takes NO provider gate (ADR 0002 exit safety — it reports on money that
already moved) and its visibility is the UNION of what the per-family reads grant,
enforced in the repository query: vault rows stay project-and-wallet scoped,
custodial rows stay program scoped. A new read over a table that holds every
movement is the obvious place for a scoping rule to go missing — do not widen it.
External-wallet rows are deliberately NOT in this union — the vault arm's
custody-wallet match is unsatisfiable for an owner-signed row — and are served
by their own per-owner reads instead (PRO-1772, external-wallet section below).

Every route reads exactly ONE source for the STATE it reports (DB or live
provider) and never blends them; that is an ADR 0002 addendum acceptance
criterion, not a style choice. The `earn_provider_wallets` row is the link
record, not state: a route may resolve which provider wallet a program is and
then read all of its money live — what it may never do is mix a persisted
balance with a live one.

- The `/button-configurations/*` routes (saved builder styling + the public
  engineering-handoff token) were removed with the dashboard UI builder;
  migration 0074 dropped `earn_button_configurations`. The retired-surfaces
  test in `../earn.test.ts` pins both paths at 404. The dashboard's
  integration guide is derived from the strategy catalogue and persists
  nothing.

- `GET /strategies[/:id]` — **DB** (synced catalogue), env-scoped. Rows are
  admitted only by the hourly sync cron; the 5-minute metrics refresh
  (`cron/earn-metrics-refresh.ts`) updates figures only and can never insert.
  - **The list is ranked by deposit size** (PRO-1732): TVL descending, read from
    `riskMetadata.tvlUsd` in SQL, no-TVL rows last (devnet rows carry none by
    design), with (created_at, id) keeping the order total so paging cannot
    repeat or skip a row. Lives in the repository's `listStrategies`, beside the
    filters, so `total` and the window describe the same ordered set.
  - **FOUR visibility filters, all server-side, enforced in
    `handlers/strategies.ts`** (the curation DATA lives in
    `handlers/curation.ts` so route tests can mock today's picks away — the
    same rule the surfacing mock in `earn-program.test.ts` follows).
    `EARN_PROVIDER_SURFACING` (@sdp/types) hides every row of a provider SDP does
    not currently OFFER — Ground today, so the shipped catalogue is Kamino only;
    `HIDDEN_STRATEGY_TERMS` hides individual Aave/Morpho/Jupiter-related rows
    ("jupiter" is the Jupiter Lend exclusion, PRO-1727 — a name term only
    because no such row exists on any registry to key an address on). The list
    pushes both into SQL (`providers: SURFACED_EARN_PROVIDERS` +
    `excludeRelatedTerms`) so `total` and the page window describe the rows the
    caller can see; `isHiddenStrategy` applies the same two rules to the detail
    route, which has no query to push them into. Keep them in that one predicate
    — a detail route that drifts from the list route leaks a row by id.
  - **Per-vault curation** sits beside them, and is the knob for an opinionated
    shelf: `HIDDEN_VAULTS` (subtractive — drop one vault, the rest keeps flowing
    in) and `CURATED_VAULTS` (a hand-picked allowlist — a provider listed there
    shows ONLY those vaults, so a newly created one does not appear until someone
    adds it). Both push into SQL so `total` moves with the rows. Since PRO-1727
    the allowlists are POPULATED — the six-vault V1 Kamino shelf on
    mainnet-beta, its devnet equivalents for sandbox — so a new Kamino vault
    does not surface until someone adds it to `handlers/curation.ts`, and
    every route test seeding an uncurated reference relies on the
    `earn.test.ts` bypass mock.
  - **Curation keys on the vault ADDRESS, never the name.** Kamino's registry is
    permissionless and the name is free text chosen by whoever created the vault,
    so a name-keyed rule can be dodged by renaming and tripped by impersonating a
    curated vault's name. `HIDDEN_STRATEGY_TERMS` is name-based only because it
    can exclusively REMOVE rows; the same trick pointed the other way would be an
    admission hole.
  - None of these is entitlement and none is `fundable`. The sync keeps STORING
    everything a provider reports, so the DB stays a truthful inventory and
    un-curating is a deploy rather than an hour's wait. None is an allocation
    gate either — `assertKnownYieldSources` reads the stored catalogue, so an
    existing program pointed at a curated-away vault keeps working.
  - Each row carries `hostCluster` (the cluster the INSTRUMENT lives on, stored)
    and `fundable` (derived per request from `hostCluster` against the caller's
    environment, never stored). **Catalogued is not the same as fundable**, and
    since PRO-1742 that is a designed steady state: the sync MIRRORS the
    production mainnet shelf into every non-production environment, written as
    two cluster-scoped lanes per environment so each sub-shelf converges
    independently (`cron/earn-catalogue-sync.ts`), so curation can be reviewed
    outside production. The LIST defaults to the environment's own cluster and
    takes an explicit `?cluster=` opt-in for the mirrored shelf; the DETAIL
    read serves an addressed row whatever its cluster. The per-vault curation
    lists below are keyed by CLUSTER, so the sandbox mirror inherits exactly
    the curation production applies. `fundable` is the wire-level warning —
    partners must branch on it rather than assume a listed strategy takes
    deposits.
  - **`fundable` answers the CLUSTER question only, and its two sides are not
    symmetric.** `false` is definitive (the instrument does not exist on your
    cluster). `true` is necessary but not sufficient: a deposit additionally
    needs the provider to expose a money-movement surface — a catalogue-only
    provider like Kamino reads `fundable: true` in production and still answers
    501 on `POST /programs` — and the org to be entitled. Those are deliberately
    NOT folded in: the field describes the instrument, while entitlement is a
    property of the caller, not of a platform-global catalogue row. The
    capability answer is delivered first and by name (`requirePortfolioClient`),
    which is what the gate order below exists to guarantee.
  - `mapToEarnStrategy` therefore takes the environment. It is the only place
    `fundable` is computed; the rule itself is
    `isClusterFundableInEnvironment` in `@sdp/earn`.

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
    (schema 400s) → `requirePortfolioClient` (501) →
    `assertEarnProviderSurfaced` (403) → `assertProviderAvailable` (403) →
    `assertKnownYieldSources` (400) → project scope (500) → key resolution
    (400). An unentitled caller sending no key still gets 403, and a provider
    without the portfolio capability still gets 501, rather than a generic
    "missing idempotency key" that hides why the call could never work.
  - **Surfacing runs BEFORE entitlement, and says something different.** This is
    the ONLY route that consults `EARN_PROVIDER_SURFACING` — the platform-level
    "we do not offer this provider", which no `providerOverrides` can lift. Its
    403 reads "not currently offered"; `assertProviderAvailable`'s reads
    "requires manual activation". Order matters because pointing a caller at an
    activation door that does not exist is worse than a plain refusal.
  - **`assertKnownYieldSources` validates against the STORED active catalogue.**
    It matches every requested `yieldSourceId` against `status = 'active'` for
    the environment, so whatever a provider client admits is allocatable and
    whatever it refuses 400s with "Unknown or inactive yield sources". Note this
    is a moving line: #1299 removed Ground's `not_solana_hosted` gate, so
    Ground's off-Solana sources are indexed and allocatable again (Ground
    bridges internally, and the deposit stays Solana-side). It does NOT re-check
    existing programs either — a wallet's current allocation stands until
    someone re-targets it in Ground.
  - **Its keep-set is filtered by `isClusterFundableInEnvironment` too**, and
    that half is separately load-bearing: a genuinely single-cluster provider's
    vaults could be catalogued in sandbox, so provider scoping alone would let
    devnet money be allocated to an instrument that does not exist on this
    cluster. This is the
    last gate before a provider mutation on both create and re-target. The route
    tests pin it with a GROUND row whose cluster is flipped — a Kamino reference
    would pass on provider scoping alone and prove nothing.
  - **Browse policy is deliberately NOT one of its gates — neither half.**
    `/strategies` list/detail hide Aave/Morpho-related rows
    (`HIDDEN_STRATEGY_TERMS`) *and* every row of an un-surfaced provider
    (`EARN_PROVIDER_SURFACING`), while the sync keeps storing both, so the DB
    stays a truthful provider inventory. This gate reads the STORED catalogue,
    so a hidden row is still a valid allocation target — correct, because hiding
    is a presentation choice and an existing program may already point at one.
    That matters most on `PUT` (re-target), which takes no surfacing gate: an
    org holding an un-surfaced provider's program must still be able to move its
    allocation, and inheriting the hide here would freeze it. Existing program
    positions are never filtered either; hiding one could hide real customer
    money.

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
- `POST /programs/:programId/withdrawal-preview` — **live provider**. `amountUsd`
  is **OPTIONAL** (PRO-1675): omitted, this is the LIQUIDITY read — what the
  `token` lane can pay right now, answered as `withdrawableUsd` with no
  `amountRequestedUsd`; present, it also validates that amount and returns its
  fee and post-withdrawal total. Money-out gate unchanged
  (`assertEarnProviderConfigured` only), so an un-credentialed provider still
  503s rather than answering a fabricated figure.
  - **The create schema no longer extends this one, deliberately.**
    `earnProgramWithdrawalCreateSchema` used to be
    `earnProgramWithdrawalPreviewSchema.extend(...)`, which would have carried
    the new optionality onto the PAYOUT path — a withdrawal with no amount.
    Each declares its own `amountUsd`; a test pins the create at 400 when it is
    missing. Do not re-couple them for the two fields they share.
  - A provider's refusal may be more informative than its success: Ground
    answers `409 insufficient_funds` with the lane's balance breakdown, which
    the provider client normalizes onto `SdpEarnError.details.balance` and
    `app.ts` already serializes into `error.details`. Consumers should read it
    rather than surfacing the provider's message.
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
  intent row in `earn_movements` — unique per (position, request_id), the
  custodial holding being 1:1 with the program wallet, so this is 0055's wallet
  scope in the unified shape: sibling projects reach the same program and, since
  PRO-1670, one caller key used against two of the org's own programs
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
  **program, not the organization**: the movement names its HOLDING, so the
  guard re-resolves it through `earn_positions` and 404s when
  `holding.provider_wallet_id !== row.id`. An
  org-only check was complete while an org held one program; with several,
  asking program A for program B's ref would pass it and then drive the provider
  with A's wallet ref and B's withdrawal ref — a mismatch whose answer is
  entirely the provider's to decide. Program scope is strictly stronger and still
  lets an unknown ref fall through. Cross-tenant scoping stays SDP's job, never
  delegated to the provider's own path scoping.
- `GET /programs/:programId/withdrawals` — **DB ledger list** (custodial
  `earn_movements` rows), the house `{withdrawals, total, page, pageSize}`
  envelope, newest first. Scoped to the path program through its holding: every
  project in the environment reaches the same programs, so one program = one
  history, and with several programs that scope is also what keeps a sibling
  program's payouts out of this list. Note it resolves the program WITHOUT
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

## Vault-direct routes (non-custodial positions)

A second money model, added for Kamino. A `vault_direct` provider custodies
nothing: there is no wallet to provision and no address to fund — the vault's
account is a PROGRAM account and stablecoins sent to it are destroyed. Money
moves only when SDP builds an instruction and signs it with one of the
organization's own custody wallets.

- `POST /vault-deposits` — **build + simulate + sign + record + broadcast**, in
  that order. Body `{strategyId, custodyWalletId, amount, minSharesOut?}` and a
  required `Idempotency-Key` header; body `requestId` is rejected.
  Registered as
  `requirePermissions("earn:write", "wallets:read")` → `policyGate` → handler.
  The caller names a CATALOGUE row, never a raw vault address, so the sync's
  admission gates still bound this path.
  - **POLICY-GATED.** `policyGate({ extract:
    extractEarnVaultDepositPolicyCandidate })` resolves everything (strategy,
    wallet, amount) and enforces wallet policy BEFORE `createOrgSigner` is
    reached. The extractor owns all the gates below; the handler only ledgers.
    Registered as the `earn` family in
    `src/security/value-moving-conformance.node.test.ts`, whose
    `valueMovingSourceRoots` now includes `src/services/earn` — it did not, which
    is how a whole money-moving surface stayed invisible to the sink inventory.
    The policy envelope is `program` / `earn_vault_deposit`; migration 0060
    re-opens that live family after the earlier vocabulary trim.
  - **Environment capability first.** `isVaultDirectDepositEnabled(environment)`
    (`@sdp/types/provider-access`) fail-closes PRODUCTION while SDP has no
    vault-withdraw route. The dashboard surfaces the durable position but
    visibly disables its exit action. Entitlement cannot express this — it is
    org-scoped, not environment-scoped. The dashboard disables the deposit
    affordance from the same constant so the opportunity remains discoverable
    without advertising an action the API will refuse.
  - `minSharesOut` is **required in production** and optional in sandbox: the
    pinned Kamino SDK picks the LEGACY deposit instruction when it is absent, so
    there is no implicit floor at all.
  - `Idempotency-Key` is **REQUIRED** and body `requestId` is rejected. There is
    no provider-side dedupe to fall back on: the chain will happily accept the
    same transfer twice. The header value is stored with a canonical
    `buildEarnVaultDepositFingerprint`, and the replay is resolved BEFORE the
    position is claimed — reusing a key with a different intent is a **409**, not
    a silent replay, and writes nothing.
  - Gate order: schema → environment capability → production floor → strategy
    resolution → deposit-style check → surfacing → entitlement →
    **catalogue admission** → wallet. `assertStrategyDepositable`
    (`handlers/admission.ts`) is shared with the custodial path and asserts
    `status = 'active'` plus `isClusterFundableInEnvironment`; without it a
    `paused` row — an operator's deliberate stop — stayed fundable by id.
  - Wallet binding takes **`earn:write`**, not `wallets:read`. A read-only
    binding must not be able to spend. Note this is the first `earn:*` scope
    asserted on a BINDING: a selected-scope key provisioned only with
    payments-family binding permissions will now 403 here.
    `custodyWalletId` is the exact `custody_wallets.id` (`cwlt_…`) returned by
    the wallet surface, never the provider-local `walletId` or public key. The
    latter can repeat across configurations; a selected binding whose provider
    id maps to multiple scoped rows fails closed.
  - Simulates before signing. The instructions come from a third-party SDK built
    against live vault state, so a stale reserve set surfaces as a readable
    program error instead of a landed, failed transaction the customer paid for.
    Provider build, simulation, custody lookup, signing, and broadcast share one
    absolute `VaultDeadline`; a slow early stage cannot reset the timeout before
    a later side effect. The verdict surfaces through
    `describeVaultSimulationError` (services/earn/vault-simulation-error.ts),
    which turns recognized `TransactionError` variants into fee-mode-aware prose
    ("the wallet holds no SOL...") with the raw variant kept in parentheses for
    log searches; unrecognized shapes fall back to the capped raw JSON. A
    failure the helper attributes to SDP's fee sponsor surfaces as a retryable
    5xx (with no sponsor detail in the body), never a caller-fault 400.
  - **The signed outbox is recorded BEFORE broadcast.** `signVaultPlan` signs
    without sending; one transaction stores the signature, base64 wire bytes,
    last-valid block height, movement and activated claim while still `pending`.
    Only the insert winner broadcasts. A send error leaves that row `pending`
    and never `failed`, because a lost response does not prove the transaction
    did not land.
  - **Who pays is configuration, not a literal** (PRO-1736). One
    `resolveVaultSponsorship` call answers it for deposits and exits alike, and
    the resolved value drives all three places that must agree: the compile-time
    fee payer, the `rentPayer` inside the provider's instructions, and the fee
    payer used to SIMULATE. Simulation matters as much as signing here, because
    it enforces that the fee payer can pay: a zero-SOL wallet simulated as its
    own fee payer dies with `AccountNotFound` and no logs, before signing.
  - **Sponsorship is devnet-only, and the cluster gate is exit safety, not
    caution.** One process serves both clusters and withdrawals are deliberately
    NOT environment-gated, so a deployment-global flag would sponsor mainnet
    exits the instant devnet deposits were enabled, against a mainnet Kora whose
    `allow_create_account` is false and a disabled mainnet budget policy. That is
    a 5xx on a customer's money-OUT path, the one failure ADR 0002 rules out.
    `isEarnVaultSponsorshipEnabled` therefore takes the cluster.
  - Sponsored signing stays sign-only, so record-before-broadcast survives
    unchanged. Turning the flag off returns both routes to `wallet-pays` with no
    code change.
  - **The exit refunds the share-ATA rent to whoever actually paid it**, which
    for an account that pre-dates the exit means `share_ata_rent_funder`
    (migration 0066) and never the current fee mode. klend never closed that
    account, so its rent used to stay locked in a zero-share account on every
    exit; the exit now closes it when it provably empties it. Do not re-derive
    the destination: sponsorship can be toggled between entering and exiting a
    position, and refunding today's sponsor for rent the customer paid takes the
    customer's lamports. The single exception is an exit that CREATES the account
    itself while consolidating, where its own rent payer funded it seconds
    earlier and the recorded value describes an older instance.
- **Swap-funded deposits (both deposit surfaces).** `sourceTokenMint` (+
  optional `swapSlippageBps`, default 2, enforced 1..500) lets a caller pay in one of
  the supported swap-source stablecoins (`EARN_SWAP_SOURCE_TOKEN_SYMBOLS` in
  `@sdp/types`: USDC/USDG/PYUSD/USDT, mint-resolved per cluster by
  `earnSwapSourceTokens`) while the vault still receives its own token: the
  API fetches raw instructions from Jupiter's Router
  (`services/earn/jupiter-swap.service.ts`, `GET {JUPITER_SWAP_API_URL}/build`,
  keyed by `JUPITER_SWAP_API_KEY`, fail-closed 503 when unset) and PREPENDS
  them to the provider plan, so swap and deposit land atomically or not at
  all. The shared normalization is `resolveDepositSwapRequest`
  (handlers/shared.ts): unsupported mint 400s, source == deposit mint is a
  no-op, a tolerance without a source 400s. Rules that follow from ExactIn
  routing: `amount` becomes the SOURCE amount; the deposit is sized to the
  swap's `otherAmountThreshold` (the guaranteed floor — output above it stays
  in the owner's token account, bounded by the tolerance); the ledger row
  records the DEPOSIT amount in the deposit mint, never the source amount,
  because `denomination` is the deposit mint. The custody path's policy
  envelope names the SOURCE mint as `asset` (that is what leaves the wallet)
  with the swap stated in `context.swap`, its fingerprint gains
  `swapSourceTokenMint`/`swapSlippageBps` ONLY when swapping (legacy
  fingerprints stay byte-identical), and it forces `wallet-pays` — Jupiter's
  programs are not paymaster-allowlisted. Oversize handling after lookup-table
  compression (`VaultTransactionTooLargeError`): one re-quote at
  `RETRY_SWAP_MAX_ACCOUNTS`, then the custody path refuses (400) while the
  external-wallet build answers the SPLIT contract —
  `{ requiresSeparateSwap: true, swap: { transaction, … }, followUp }`, an
  unsigned swap-only transaction the owner signs and broadcasts itself
  (persisting nothing), followed by an ordinary unswapped build for
  `followUp.amount`. Jupiter routes MAINNET only: on devnet the mints are
  pinned per cluster but Jupiter answers "not tradable", surfaced as a 400.
- `POST /vault-deposit-previews` — the deposit QUOTE: what the vault's own
  live accounting would mint for `{strategyId, amount}`, from which the
  dashboard derives its `minSharesOut` floor. A live read SHAPED LIKE MONEY-IN:
  no wallet, no policy gate, no idempotency key — it moves nothing — but it
  exists only to open a NEW position, so it takes the deposit's own gate order
  deliberately: registered as `requirePermissions("earn:read")` → handler,
  which applies the environment fail-close (`isVaultDirectDepositEnabled`,
  403), catalogue row (404), deposit style (400), `assertEarnProviderSurfaced`,
  `assertProviderAvailable`, admission (`assertStrategyDepositable`), then
  capability (`supportsVaultDepositQuote`, 501 for a provider that cannot
  quote). A vault that will not take the deposit answers 200 with
  `blockingIssues` in the provider's own words; an unusable amount maps through
  the shared refusal vocabulary (`services/earn/vault-refusals.ts`) to a 400.
  POST because the parameters are a body, like the custodial
  withdrawal-preview. See "Gate asymmetry" for why this preview alone carries
  money-in gates.
- `GET /vault-deposits` — this workspace's recorded deposits, **DB only**,
  newest first, keyset-paged. The DISCOVERY tier: it is what lets a client
  re-derive which of its deposits are still in flight after losing local state,
  the way the custodial side re-derives withdrawals from its ledger. Scoped by
  organization, environment, direction, PROJECT and wallet binding — the same
  five rules as the detail read.
  - `?requestId=` narrows to the caller's own idempotency key, and that is how
    an **approval-gated** deposit becomes findable. A policy hold returns an
    `approvalRequestId` and no `movementId` because no movement exists yet; the
    approval executor replays the caller's original `Idempotency-Key`
    (`services/policy/approved-operation-replay.ts` stores it in
    `wallet_operations.raw_payload.executionRequest` and re-sends it as a real
    header), so the movement it later creates carries it. **That preservation is
    platform behaviour this route DEPENDS on** — if the executor ever derived
    its own key instead, `?requestId=` would silently stop finding approved
    deposits. It has no direct test today; the fixture needed to drive
    `executeApprovedWalletOperation` has to reproduce the exact policy-gate
    operation record, and that belongs in the approvals domain, not here.
  - A key is caller-chosen `[\x20-\x7e]{1,255}` (`middleware/idempotency-key.ts`),
    so it may be one character, and it is **published on chain** in the deposit
    memo (`services/earn/vault-deposit.service.ts`). It is therefore never a
    capability: the route re-applies every scoping rule, so a guessed key can
    only surface a deposit the caller could already read. It is also why the key
    is a QUERY filter and not a path segment — legal keys contain `/` and `?`.
  - **The replay decision is project-scoped IN THE REPOSITORY, not only at the
    route.** `findVaultMovementByRequestId` is keyed on `(organization_id, request_id)`
    and the server fingerprint (`buildEarnVaultDepositFingerprint`) omits the
    project, so a key first used by a SIBLING project matched on both and its
    movement was returned as a replay — the wrong deposit, plus its amount and
    signature. Reachable because an organization-level custody config gives two
    projects the same `custody_wallets` row. The rule is ONE exported function —
    `assertMovementIsOwnReplay` (`db/repositories/earn-movements.repository.ts`) —
    enforced at EVERY site that resolves a replay: the route guard
    (`findEarnVaultDepositIdempotentKeyReplay`), `depositIntoVault`'s fast
    sequential preflight (`services/earn/vault-deposit.service.ts`), the
    `createSignedDepositIntent` transaction preflight, and the concurrent-insert
    loser. It kept re-appearing as a bug precisely because it was re-implemented
    per site — the route guard was fixed and the repository missed; the
    repository was fixed and the service fast path missed. A new replay site
    calls the shared function or it is wrong. The multiplicity is required, not
    redundancy: the route guard is deliberately skipped for an
    approved-operation execution, and `wallet_operations` uniqueness is
    per-PROJECT, so sibling projects can each hold an approval with the same
    key.
    Deliberately NOT fixed by adding the project to the fingerprint: that value is
    persisted in `wallet_operations.raw_payload.executionRequest`, so changing it
    would 409 every in-flight retry across a deploy. A sibling's approved
    operation that hits this conflict records `failed` with the 409 as its
    `execution_error` (`completeWalletOperationExecution` treats any non-2xx as
    failure), so the outcome is visible on the approval surface, never silent.
  - `?settled=false` returns only movements that can still change, and recovery
    always asks for that. It is not a convenience: a client filtering an
    unbounded history locally has to page it all, and a workspace busy enough to
    push an in-flight deposit past the first page would silently stop tracking
    it. The reconciliation sweep drives every row terminal within ~90 seconds,
    so the in-flight set is small by construction.
  - 0062's `idx_earn_movements_direction_created` (`(organization_id,
    environment, direction, created_at DESC, id DESC)`) is what orders this
    page; the sweep, replay, chain and per-position lookups each have their own
    index — none of them can.
- `GET /vault-deposits/:movementId`: one recorded movement with a scoped,
  fail-soft read-through of its exact Solana signature. Chain truth advances the
  same guarded ledger row immediately; an RPC failure returns the last durable
  row and leaves recovery to the scheduled reconciler. The read never
  rebroadcasts or expires an unknown signature. `pending` here means "SDP could
  not establish that this reached the network", never "failed".
  - **No provider gate**, same ADR 0002 reason as `/vault-positions`: it reports
    on money that has already left the customer's wallet, so un-offering the
    provider must not take away the answer to "did my deposit land". Deliberately
    no strategy lookup either — an un-catalogued strategy must not cost anyone
    that answer, so the response carries `provider`/`providerReference` off the
    movement row and leaves the display name to the caller.
  - **Three scoping rules, all answering 404 rather than 403** — a caller who may
    not see a movement must not learn it exists. ORGANIZATION (enforced inside
    the repository query; the BOLA guard, same reasoning as
    `getEarnProgramWithdrawal`), ENVIRONMENT (a sandbox key must not read a
    production movement; the row carries its own, so this is a comparison and
    not a second query), DIRECTION (`withdraw` is not a deposit — the column is
    the only thing separating the two on a shared table, and it closes the
    vault-withdraw path before there is anything to leak through it), and
    PROJECT (an EXACT match — `project_id` is nullable only through
    `ON DELETE SET NULL`, so a null means the project was DELETED, and accepting
    it would hand that project's deposits to every sibling project sharing an
    organization-level custody wallet).
  - Wallet-binding scope comes from `listReadableEarnVaultWallets`, **shared with
    `/vault-positions`**. Keep it shared: a binding that hides a position has to
    hide that position's deposits too, and two copies of that rule is how they
    drift. Both routes are pinned together in `../earn.vault-positions.test.ts`.
- `GET /vault-positions` — DB claim rows **hydrated live from chain**. Shares and
  value are never persisted: for a non-custodial vault the chain IS the provider.
  Takes **no provider gate at all** — it is a read of money the org already
  holds, and hiding it when a provider is un-offered would close the door out.
  It DOES take wallet-binding scope: `getAllowedApiKeyWalletIdsForPermissions(auth,
  ["earn:read"])`, applied in the repository query before any chain read. Mind
  the id spaces — that helper returns provider `walletId`s (`privy_…`) while
  `earn_positions.custody_wallet_id` is the `cwlt_…` row id, so the handler
  translates through `scope.wallets`. Passing the allow-list straight through
  matches nothing and silently returns an empty page.
  A failed chain read leaves a position UNHYDRATED rather than zero; reporting
  zero is a claim about someone's money that a failed RPC call cannot support.

- `POST /vault-withdrawal-previews` — the exit QUOTE the dashboard derives its
  `minAmountOut` floor from (`supportsVaultWithdrawQuote`; 501 for a provider
  without the capability), the deposit preview's mirror with deliberately
  DIFFERENT gates: EXIT gates only (ADR 0002) — position scoping and the
  read-side wallet binding, both 404 — no surfacing, no entitlement, no
  admission, no environment capability. Registered as
  `requirePermissions("earn:read", "wallets:read")`: `wallets:read` is not a
  money-in gate, and for a key with NO wallet bindings the binding check is a
  documented no-op, so dropping it would let an earn:read-only key read any
  org position's live payout while `GET /vault-positions` answers it 403.
  The dashboard fingerprints each flow's idempotency key on the USER'S
  tolerance (reproducible after a reload) and remembers the floor a held key
  was minted with separately, because the API's own fingerprint includes the
  floor and refuses a replay that changed it.

Capability dispatch is `supportsVaultDirect` (`@sdp/earn/capabilities`), resolved
through `services/earn/execution-registry.ts` — the one place a provider id maps
to an executing client. `EARN_PROVIDER_CLIENTS` stays the CATALOGUE registry so
the hourly sync keeps its small dependency surface.

The every-minute vault reconciliation worker consumes
`idx_earn_movements_unsettled` in bounded pages. Both the embedded cron and the
dedicated Cloud Run job use the same transition service as the interactive
detail reads. The job additionally rebroadcasts the recorded signed bytes while
the blockhash remains valid and marks an expired, unlanded movement failed.
Never rebuild a transaction during recovery.

### Vault withdrawals — the exit half (PRO-1702)

- `POST /vault-withdrawals` — **build + simulate + sign ALL legs + record ALL
  legs + broadcast in order**. Body `{positionId, shares, minAmountOut?}` and a required
  `Idempotency-Key` header (body `requestId` rejected, same as deposits).
  Registered `requirePermissions("earn:write", "wallets:read")` → `policyGate`
  (extractor `extractEarnVaultWithdrawalPolicyCandidate`; family `program`,
  type `earn_vault_withdrawal`; asset = the SHARE mint, the token actually
  leaving the wallet) → handler. Registered as the second `earn` entry in
  `value-moving-conformance.node.test.ts`.
  - **The caller names its own POSITION, never a strategy and never a raw
    vault address.** The position row carries the vault, the signing wallet
    and both mints, so the exit has NO catalogue dependency — a delisted vault
    stays exitable. `expectedAssetIdentity` is the position's stored mints.
  - **Gates: 404 position scoping (org+environment+kind), wallet binding with
    `earn:write`, wallet policy — and nothing else.** No surfacing, no
    entitlement, no availability, no admission, no environment capability
    (`isVaultDirectDepositEnabled` deliberately not consulted: an exit works in
    production today, where deposits are closed). The only provider-shaped
    answer is capability: `resolveVaultWithdrawClient` narrows on
    `supportsVaultWithdraw` and a provider without it is a 501 — a statement
    about SDP's plumbing, never permission. Pinned by the exit-safety describe
    in `../earn.vault-withdrawals.test.ts`.
  - **ONE TRANSACTION MODEL.** A vault exit is one `earn_movements` row,
    denominated in the share mint, with one signature, signed transaction and
    blockhash window. The complete Kamino instruction sequence is compiled with
    its lookup table and idempotency memo; plans above Solana's packet limit are
    rejected. The row is durable before broadcast and uses the same reconciler
    as a deposit.
  - The wire exposes the movement signature directly for explorer links.
    `confirmed` remains non-terminal; only `finalized` and `failed` stop polling.
- `GET /vault-withdrawals` / `GET /vault-withdrawals/:movementId` — the deposit
  reads mirrored: the list is DB discovery and the scoped detail is a fail-soft
  signature read-through. Both have NO provider gate (ADR 0002), the same four
  404 scoping rules with `direction = 'withdrawal'`, and the same wallet-binding
  scope through `listReadableEarnVaultWallets`. `?requestId=` serves the one
  logical withdrawal, and `?settled=` uses the ledger terminal set
  (`finalized|failed`), not the deposits' legacy one.

### External-wallet (caller-signed) routes — the B2B2C money path (PRO-1722)

A third signer, not a third model. An *external wallet* is a NON-CUSTODIAL
wallet the partner's platform connects — SDP holds no key for it and its owner
is not an SDP tenant. Its movements are `vault_direct` rows in the same ledger:
one signed transaction, recorded before broadcast, settled by the same
reconciler. The
signer distinction is a column pair — exactly one of `custody_wallet_id` and
`owner_address` per vault row (migration 0070) — and every treasury read
scopes by custody wallet, so external-wallet rows are structurally invisible
to those surfaces. Full contract: ADR 0002 addendum 2026-08-26.

Each direction is BUILD then SUBMIT (`handlers/external-wallet.ts`,
`services/earn/vault-external-wallet.service.ts`):

- `POST /external-wallet/deposit-transactions` — **build + simulate + compile,
  never sign.** Body `{strategyId, ownerAddress, amount, minSharesOut?}`. Runs
  the FULL money-in stack in the custody deposit's order (environment
  capability, production floor, surfacing, entitlement, admission), builds the
  provider plan for the OWNER, simulates with the owner as fee payer (which is
  also the funds check), compiles one unsigned transaction and persists it
  (`earn_external_wallet_transactions`), returning
  `{transactionId, transaction}` for the external wallet to sign. The memo
  binds the TRANSACTION id (the submit's key does not exist yet at build time).
  No idempotency key: a build moves no money and expires with its blockhash.
- `POST /external-wallet/deposits` — **verify + record + broadcast.** Body
  `{transactionId, signedTransaction}` plus a REQUIRED `Idempotency-Key`
  (body `requestId` rejected). The submit proves the bytes are a transaction
  SDP built — MESSAGE bytes compared against the stored build, owner's ed25519
  signature verified — and takes nothing but signatures from the wire. The
  movement is recorded durably, THEN broadcast: record-before-broadcast
  unchanged, the signature merely became knowable at submit instead of at
  SDP's signer. Two composed idempotency protections: the key anchors the
  movement (a partner retry replays the original), and each build is
  consumable at most once under a row lock (a second key against the same
  build is a 409, never a second row for one on-chain transaction). The
  fingerprint includes the build id, so a key reused against a REBUILT
  transaction conflicts rather than silently replaying.
- `POST /external-wallet/withdrawal-transactions` — the exit build, ADR 0002
  exit safety in its strongest form: 404-scoping (org, environment, EXACT
  project, owner shape — a custody position 404s here) and capability (501)
  only. Works while the provider is disabled for new deposits; pinned by the
  exit-safety describe in `../earn.external-wallet.test.ts`.
- `POST /external-wallet/withdrawals` — the submit, mirrored.
- **NO policyGate and no `wallets:read`, deliberately** — this is not the
  vault-deposit cautionary tale repeating. Wallet policy governs the org's own
  custody and stands between a request and `createOrgSigner`; these routes
  never resolve a signer and never touch custody. The owner's own signature
  IS the authorization, and there is no signing sink here for
  `value-moving-conformance.node.test.ts` to inventory.
- **Scoping is org AND project**, stricter than custody vault claims: the
  external wallet belongs to the partner's project
  (`idx_earn_positions_external_wallet_claim` includes `project_id`), so a
  sibling project can neither see nor exit its positions. Position reads for
  partners are PRO-1724, not here.
- The owner pays fee and rent (Kora sponsorship for this surface is PRO-1744 —
  see the ADR addendum for why co-signing a stranger's transaction is its own
  decision, not a default), and the rent funder is recorded NULL so the exit's
  refund defaults back to the owner.

The per-owner READS (PRO-1772) close the loop the money routes open. All three
take `earn:read` only — no `wallets:read` (end-user wallets carry no custody
bindings, same as the position reads) and NO provider gate (ADR 0002: they
report on money that already moved). All 404 an owner the exact project has
never claimed a position for (`hasExternalWalletPositionOwner` — existence and
ownership collapse to one answer), and none of them is reachable through
`GET /movements`, whose vault arm requires a custody-wallet match an
owner-signed row can never satisfy
(`idx_earn_movements_external_wallet_owner`, migration 0073, serves all
three).

- `GET /external-wallet/movements?ownerAddress=…` — **DB ledger list**, one
  owner's activity newest first in ledger vocabulary, keyset-paged, with
  `direction`/`status` equality filters. The owner is a REQUIRED query filter
  rather than a path segment so the collection keeps its `:movementId` detail
  route unambiguous.
- `GET /external-wallet/movements/:movementId` — **DB**, the poll that makes
  the submit's record-before-broadcast answerable on this surface. Scoping
  answers 404 across the board: organization, EXACT project, environment, and
  the external-wallet shape itself (`owner_address IS NOT NULL` — a
  custody-signed movement guessed by id reads as missing). `replayed` is
  POST-only and never appears on reads.
- `GET /external-wallet/earnings/:ownerAddress` — **DB ledger + live chain**,
  balance and total earned per deposit token. `earned` = live `currentValue`
  minus `totalDeposited` (Σ finalized SDP deposits), stated ONLY when exact and
  never coerced to zero; otherwise absent with a named
  `earnedUnavailableReason`: `live_value_unavailable` (hydration failed),
  `movements_pending` (a movement is still settling, so chain and ledger
  describe different moments), or `withdrawals_not_valued` (exits are ledgered
  in SHARES — 0070 pins `payout_token` NULL for vault rows — so once money has
  gone out no exact token-denominated figure exists; recording the observed
  token payout at settlement is the follow-up that would close this).
  Token-level `earned` is computed as Σlive − Σdeposited, which equals the
  per-position sum, and is withheld whenever ANY contributing position cannot
  state it — never partial. **Figures cover CURRENTLY HELD positions only**: a
  fully exited position drops out entirely — its deposits leave
  `totalDeposited` along with its unvalued withdrawal — because consuming its
  history would report `withdrawals_not_valued` forever after any full exit,
  while the open positions' earned is perfectly exact. The exited history
  stays on the movements list; pinned by the closed-vault test in
  `../earn.external-wallet-activity.test.ts`. The ADR 0002 hydration caveat
  applies at full strength: live value reads the owner's WHOLE vault balance,
  so shares acquired outside SDP inflate `earned`; documented property, not a
  bug.
  This read does not blend sources for one figure: `totalDeposited` is ledger,
  `currentValue` is live, and `earned` is openly their difference — that is
  its definition, not a violation of the one-source rule.

One gap remains around approvals, and it is narrower than it was. An approved
deposit or withdrawal is now fully followable — the executor writes the
movement(s) and the list reads find them — but a REJECTED approval never
produces a movement, so nothing on this surface reports it. That outcome is
observable via `GET /v1/wallets/approval-requests/:approvalRequestId`, whose
`status` plus nested `operation.status` distinguish rejected/canceled from
approved-and-executed. Wiring the dashboard to it is deliberately not done
here. `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` still fail-closes production
DEPOSITS — the remaining blocker is PRO-1703 (vault positions on the Active
tab), not the exit path.

**Per-cluster RPC.** `resolveClusterRpcUrl` reads `SOLANA_DEVNET_RPC_URL` /
`SOLANA_MAINNET_RPC_URL`, falling back to the canonical default only when its
configured `SOLANA_NETWORK` matches the requested cluster, and
`assertClusterEndpoint` proves the endpoint by GENESIS HASH before anything is
built against it (cached per endpoint). One process serves both environments, so
the old cluster-agnostic read silently built against whichever chain the single
URL happened to serve — and a mismatch does not error, because Kamino's mainnet
kvault program id also resolves on devnet with no accounts under it.

## Gate asymmetry — DO NOT BREAK (ADR 0002 exit-safety)

- **Money-in** (`POST /programs`, `PUT /programs/:programId`):
  `assertProviderAvailable` (entitlement + enablement + credentials).
- **New positions only** (`POST /programs`): `assertEarnProviderSurfaced`.
  Surfacing gates the way IN and nothing else — every read, every money-out
  route, and `PUT` (re-target) ignore it, so un-surfacing a provider can never
  strand a position taken while it was offered. `POST /programs` is the only
  route that opens a *new* commitment, which is why it is the only one that
  refuses. Pinned by the "un-surfaced provider" describe in
  `../earn-program.test.ts`, whose second test asserts read/re-target/withdraw
  all still work.
- **Money-out and live reads** (withdrawals create/detail, previews, program
  get, programs list, deposits list): `assertEarnProviderConfigured` ONLY — a
  disabled provider must never trap funds. The list resolves capability +
  credentials ONCE per distinct provider among the listed rows — before any
  live read, so a de-registered or vault-only provider fails the list with a
  clean 503/501 instead of mid-fan-out — and once more up front for a
  `provider` filter so an empty list still 503s (see route map).
- **The vault exit** (`POST /vault-withdrawals`): the strongest form of the
  asymmetry — no provider gate of ANY kind, not even the credential check
  (Kamino is keyless; a credentialed vault provider's own client throws
  `PROVIDER_NOT_CONFIGURED` from inside its build). Capability (501) is the
  only provider-shaped refusal, and wallet policy is the org's own custody
  control, not a provider gate. It also ignores `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS`:
  the environment fail-close guards the way IN only.
- **The vault deposit preview** (`POST /vault-deposit-previews`) is the one
  deliberate EXCEPTION among previews: a live read shaped like MONEY-IN,
  because a deposit quote exists only to open a new position. It takes the
  deposit's own gates — environment fail-close, surfacing, entitlement,
  admission — rather than the `assertEarnProviderConfigured`-only rule above,
  and that does not violate the asymmetry: nothing about an EXISTING position
  is ever answered through it, so refusing it can never trap funds.
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
  providers lacking the surface. Kamino implements NONE of it, so every
  **program** route still answers 501 for it by capability, never by a
  provider-id check — its money moves through the vault-direct routes above
  instead. The two capabilities are asserted mutually exclusive.
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
- Catalogue rows are admitted ONLY via the sync cron
  (`src/cron/earn-catalogue-sync.ts`). The metrics refresh
  (`src/cron/earn-metrics-refresh.ts`) runs every 5 minutes and is UPDATE-only,
  so it can never admit a row. Cadence and failure behaviour:
  `packages/sdp-earn/README.md` → "Catalogue data".
- Whole-stack local setup (ports, flags, Ground key, entitlement, troubleshooting):
  `packages/sdp-earn/CLAUDE.md` → "Local development".
- **Tests must not depend on which providers are surfaced today.** Ground is the
  only portfolio-capable provider and it is currently un-surfaced, so
  `POST /programs` 403s for it in the shipped config — but idempotency, replay,
  gate order and environment isolation still have to work for whichever provider
  is offered next. `earn-program.test.ts` therefore partial-mocks
  `isEarnProviderSurfaced` (a `vi.hoisted` flag, forced on in `beforeEach`), and
  the gate gets its own describe that flips the flag off and runs against the
  real map. `earn.test.ts` seeds a SURFACED provider by default for the same
  reason. When a surfacing change breaks a suite, copy that pattern — do not
  edit `EARN_PROVIDER_SURFACING` to make a test pass.
- Tests: vitest; stub `EARN_PROVIDER_CLIENTS.<id>` methods with `vi.spyOn`;
  repository tests use testcontainers. The ledger repository/service suites in
  `../../db/repositories/earn.repository.test.ts` run against a NON-Ground
  stub id on purpose — the ledger consumes only the canonical contract, and
  that suite is the pluggability proof.
