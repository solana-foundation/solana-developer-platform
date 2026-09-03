# dashboard/markets/earn — agent notes

The Earn dashboard module. **All live data** — there is no mock seam; do not
reintroduce fixture modules. Data flows: BFF proxies
(`src/app/api/dashboard/markets/earn/*` → `/v1/earn/*`) → SWR hooks → UI.

This module was rebuilt on live provider and organization capability. The
Markets prototype it replaced (the deposit wizard, `earn-workspace`, the
opportunities table, the playground, the route skeletons) is gone; nothing
here fabricates a position, a rate, or a success state.

## The BFF proxy tree

Mirrors the API's collection shape (PRO-1670 — there is no singular `program/`
folder):

```
api/dashboard/markets/earn/
  provider-query.ts                  allowlisted query passthrough — lives at
                                     the earn/ ROOT because its importers sit
                                     at several depths under programs/
  strategies/route.ts
  programs/route.ts                  GET list (page window) · POST create
  programs/[programId]/route.ts      GET one · PUT re-target
  programs/[programId]/
    deposits/                        GET (cursor)
    withdrawal-preview/              POST
    withdrawals/                     POST create · GET ledger list
    withdrawals/[withdrawalRef]/     GET detail
  vault-deposits/route.ts            POST create (vault_direct)
  vault-deposits/route.ts            …and GET the workspace list (recovery)
  vault-deposits/[movementId]/       GET one recorded deposit (poll to terminal)
  vault-withdrawals/route.ts         POST create (vault exit) · GET the movement list
  vault-withdrawals/[movementId]/    GET one recorded withdrawal
  vault-positions/route.ts           GET list (keyset cursor)
  movements/route.ts                 GET the cross-provider ledger feed
                                     (keyset cursor + equality filters)
```

`provider-query.ts` holds FIVE validators with deliberately different failure
modes. `programProxyQuery` is permissive-by-omission — an unrecognized param is
dropped — because those routes predate the typed client and are reachable with
arbitrary query strings. `vaultPositionsProxyQuery` is **strict**: it is
consumed only by our own typed client, so an unknown key, a repeated key, an
out-of-range `limit` or a non-base64url cursor **400s** instead of silently
reshaping the page. A typo must not return a different page of someone's money.
`vaultDepositsProxyQuery` is the same posture over the deposits list, sharing
`ProxyQueryValidation` and `MAX_CURSOR_LENGTH` rather than restating them; its
`requestId` is validated to the API's OWN `[\x20-\x7e]{1,255}` idempotency-key
shape, because a tidier rule would 400 a legitimate key containing a slash.
`vaultWithdrawalsProxyQuery` is its exit mirror, parameter for parameter.
`earnMovementsProxyQuery` (PRO-1705) is strict in the same way over the
cross-provider feed, and its filter values are checked for SHAPE and length only,
never against a vocabulary: `status` is per execution model and `provider` is an
open registry string, so a copy of either list here would need revising every time
one grows — and the API already answers an unknown value with an empty page, which
is the honest result.

`proxyToSdpApi` never copies the inbound header bag — auth, project scope and
tracing stay server-owned — so a client-set `Idempotency-Key` never reaches the
API on its own. A route forwards one deliberately, per header, through the
optional `upstreamHeaders` argument, spelling it `IDEMPOTENCY_KEY_HEADER`
(`src/lib/idempotency.ts`). `vault-deposits/` and `vault-withdrawals/` are the
two routes that opt in, forwarding that single header and nothing else; the
program create still sends the body `requestId` form.

## Routes

- `/dashboard/markets/embedded-yield` → `EarnProgramWorkspace`: pick a strategy
  from the live catalogue, then continue to the integration guide. The
  canonical page and loading files live in `../embedded-yield/`; this directory
  keeps shared internal Earn modules and legacy route shims only.
- `/dashboard/markets/embedded-yield/integrate` → `EarnIntegrationGuide`: the
  sectioned **server-side** integration guide for the EXTERNAL-WALLET flow —
  the WHOLE loop (PRO-1722 + PRO-1772), not just the deposit: build via
  `POST /v1/earn/external-wallet/deposit-transactions`, the customer's wallet
  signs, submit via `POST /v1/earn/external-wallet/deposits`, then poll
  `GET …/movements/:movementId`, read `GET …/earnings?ownerAddress=`
  (balance + earned; `earned` can be ABSENT with `earnedUnavailableReason` —
  render a dash, never $0), list `GET …/movements?ownerAddress=` and
  `GET …/positions?ownerAddress=` (the owner rides the query on every
  per-owner read), and exit via
  `…/withdrawal-transactions` + `…/withdrawals`. The treasury
  route (`/vault-deposits` + `custodyWalletId`) must not reappear in the
  snippets — a B2B2C partner cannot name a custody wallet. The optional
  partner `feePayer` (the implementor sponsoring its customers' fees) is
  documented in the public docs guide
  (`apps/sdp-docs/content/docs/guides/embedded-yield.mdx`), which mirrors
  these snippets — update both together. The guide is
  entirely derived from the strategy catalogue: nothing is persisted, there is
  no styling to save, and no public handoff token exists. (The UI builder that
  used to hold those — styled previews, saved per-project configuration, the
  public `/embedded-yield/integrate/:token` handoff page and its
  `/v1/earn/button-configurations/*` API — was removed; migration 0074 dropped
  its table. Do not reintroduce persisted presentation state here.)
- Both routes are `dynamic = "force-dynamic"` and resolve
  `loadEarnProviderAccess()` server-side per request. Provider access is
  organization-scoped; caching it would hand one org's entitlement to another.
- No layout of its own: `../layout.tsx` gates the whole Markets segment on
  both `markets()` and `earn()` (`notFound()`), enforced once there so no child
  layout suspends on a flag read (which would paint the parent's loading
  boundary on hard navigations). Pages hold no flag checks: add new Earn routes
  under this segment and they inherit both gates.
- Loading states come from `../markets-route-skeletons`, with distinct portfolio,
  configuration and integration-guide shapes. The shell's navigation-loading
  resolver (`lib/dashboard-navigation-loading.ts`) maps each pathname to the
  same route-specific skeleton used by its `loading.tsx` boundary.
- The portfolio's zero-position state is the onboarding card. The removed UI
  builder persisted the only former configuration state, so there is no honest
  "configured but awaiting a deposit" distinction to infer from the live
  position summary.

## Module map

- `earn-surfacing.ts` — the availability brain. `SURFACED_CUSTODIAL_EARN_PROVIDERS`,
  `SURFACED_VAULT_DIRECT_EARN_PROVIDERS`, `EARN_PROGRAM_CREATION_ENABLED`,
  `EARN_PROGRAM_CREATE_PROVIDER` and `earnVaultDepositAvailability`, all DERIVED
  from `@sdp/types` — **no provider id is hand-set here**. Carries no
  `"use client"` directive, on purpose (see "The client/server boundary bug").
- `earn-provider-access.server.ts` — `loadEarnProviderAccess()`: reads
  `/v1/onboarding/status` then provider availability for that organization.
  Every failure path returns `null`, and `null` disables deposit actions. A
  catalogue row says a strategy EXISTS; it never says this organization may
  fund it.
- `earn-program-workspace.tsx` — the strategy table. Each row asks
  `earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess)` and
  renders the answer as a badge; an unavailable row stays **visible with its
  Select button disabled**, never hidden and never silently enabled. Continue
  routes to the integration guide with `?strategy=<id>`.
- `earn-integration-guide.tsx` — re-checks availability itself rather than
  trusting the referrer, and refuses with a named empty state for each way in
  that can fail (catalogue error / unknown strategy / missing strategy /
  environment, access, provider, or strategy unavailable). Renders the guide as
  four ordered sections (client setup, deposits, reads, withdraw), each a card
  over its slice of the one server module. The snippets remain server-only and
  say so, because the module they document carries a secret API key.
- `earn-integration-snippets.ts` — the snippet source,
  `buildEarnIntegrationSections(strategy)` (+ `buildEarnServerIntegration`,
  the sections joined). Pure string building so the exact wire contract is
  unit-testable without rendering.
- `earn-program-data.ts` — THE data seam, over the BFF proxies above.
  `useEarnStrategies()` is what this module's pages read today — it takes an
  optional `{ cluster }` (PRO-1742), the explicit opt-in that browses the
  mirrored mainnet shelf; the cluster is part of the SWR key. Treasury's
  strategies card passes it from its sandbox-only toggle and deliberately keeps
  a SECOND, default hook call alive: the default read doubles as the
  allocation summary's share-mint vocabulary, and repointing it at mainnet
  would blank the devnet vocabulary under the page (the two calls share one
  SWR key until the toggle leaves the default). The program,
  vault-position and vault-deposit seams serve Treasury Solutions next door (see
  "Where these seams are consumed"). **No provider id is spelled in this file** — surfacing comes
  from `./earn-surfacing`, and reads are provider-agnostic on purpose so a
  position taken while a provider was offered stays visible after it is
  un-surfaced (ADR 0002 — un-surfacing closes the door in, never the door out).
  All three paginated readers **page to the end** and fail loudly rather than
  truncating: `fetchEarnStrategies` stops on the reported total or a short page
  and throws if pagination ends early, and `fetchEarnVaultPositions` follows the
  opaque keyset cursor, throwing if the cursor repeats or does not advance. A
  silently short page is hidden MONEY.
- `earn-withdraw-modal.tsx` — portfolio-level withdrawal: stablecoin, amount,
  Solana destination; preview → confirm → submitted. Every figure it quotes
  comes from the PROVIDER, never a local estimate (PRO-1675) — see
  "Withdrawal rules" below. The selected token is `EarnPortfolioToken |
  undefined` and the form subtree renders only once it is a REAL lane: seeding
  state with a default stablecoin would make every read below depend on
  remembering to fail closed, and the provider-unavailable case would silently
  hold a lane that cannot pay out.
- `earn-vault-deposit-modal.tsx` — the `vault_direct` deposit: one SDP custody
  wallet funds one strategy, and that same wallet signs on chain and holds the
  shares. A vault address is never presented as a funding address. The
  idempotency key is derived from a request SIGNATURE — `(strategy, wallet,
  amount)` — so re-pressing submit after a timeout replays the same key, while
  editing any of the three mints a new one: a retry is not a second deposit, and
  a changed deposit is not a retry. `validateVaultDepositAmount` never touches a
  JavaScript number; trailing zeroes past the mint scale are harmless, but a
  non-zero digit below one atom is REJECTED rather than rounded before a
  value-moving request. `walletBalanceForMint` distinguishes an absent or
  malformed RPC observation (`undefined`) from a successful observation with no
  row for the mint (a real zero) — only the latter may read as "no funds".
  It also exports `EarnVaultDepositOutcomeTracker`, the null-rendering watcher
  Treasury mounts per in-flight deposit — the modal's success screen is a
  receipt for a SIGNATURE, and the customer closes it long before the chain has
  decided.
- `earn-vault-deposit-tracking.ts` — the per-tab `sessionStorage` holding the
  deposit IDEMPOTENCY KEY, and nothing else (PRO-1692). A retry inside the
  record-before-broadcast window must carry the SAME key or the chain accepts
  the transfer twice — there is no provider-side dedupe behind this route — and
  a React ref dies with the modal and with the page load.
  - The fingerprint is `(project, strategy, wallet, amount, toleranceBps)` —
    the USER'S tolerance, never the quote-derived floor, because the
    fingerprint must be reproducible from what the user can re-enter after a
    reload or the cross-reload replay is fiction. "Raise the tolerance and
    retry" still mints a fresh key. The floor a HELD key was minted with is
    remembered separately and replayed verbatim (the API's own fingerprint
    includes `minSharesOut` and refuses a replay whose floor changed); see
    `rememberVaultDepositFloor` in earn-vault-deposit-tracking.ts. The PROJECT is in
    there because an organization-level custody config gives two projects the same
    `custody_wallets` row: without it, switching project in one tab and
    re-submitting the same strategy and amount reuses the first project's key, and
    the API's org-scoped replay lookup then resolves the FIRST project's movement.
    A ref-scoped key never survived a project switch, so this only became
    reachable once the key outlived the component. The API refuses that case too
    (see `routes/earn/CLAUDE.md`) — this keeps the client from asking.
  - **The value-moving POST takes no abort signal.** The server processes the
    request whether or not the component survives it, so aborting on unmount
    only blinds the client to an answer the STORE needs: a 202 hold whose key
    was never pinned stays on the 15-minute TTL while the approval lives for
    hours, and the eventual resubmit mints a fresh key — a second approval
    request for one intent. The controller gates state updates and the outcome
    screen; key bookkeeping (`applyVaultDepositIdempotencyKeyOutcome`) runs
    unconditionally, before the abort check.
  - `claimVaultDepositIdempotencyKey` mints once per fingerprint; `releaseVaultDepositIdempotencyKey` retires it. **Retire only on
    a 4xx or a recorded deposit.** A 5xx is the dangerous one — a gateway timing
    out downstream of an API that already recorded and broadcast looks exactly
    like a provider being unavailable before it did. A key released too early is
    a double deposit; a key held too long is a replay the API reports honestly.
  - `holdVaultDepositIdempotencyKey` SUSPENDS expiry while a policy approval is
    pending. The default TTL is calibrated to a blockhash (~90s to terminal);
    an approval answers to a human and can take hours, and a lapsed key there
    resubmits into a SECOND approval request for one intent.
  - Suspending expiry needs its own way OUT, or the key outlives the approval and
    a later legitimate deposit of the same amount from the same wallet silently
    replays the approved one. So before reusing a HELD key the modal asks the
    server whether a movement exists for it
    (`isVaultDepositIdempotencyKeyHeld` -> `fetchEarnVaultDepositByRequestId`): a
    movement means the write happened and the key is spent. That lookup returns
    THREE outcomes — `found` / `absent` / `unavailable` — and an unavailable read
    REFUSES the submit rather than picking a key, because both guesses are wrong
    in a different direction: reusing a possibly-spent key moves no money when
    the customer asked it to, and minting a fresh one opens a second approval
    request. Same rule as an unavailable balance, which must never read as zero.
  - The pre-flight and the POST are two operations, so the approval can execute
    BETWEEN them — a TOCTOU no further client read can close. Detection lives on
    the RESPONSE instead: the key is client-minted and the approval executor
    replaying it is the only other writer, so `replayed: true` on a key that was
    HELD at check time is necessarily the approval's execution.
    `resolveDepositSubmission` marks that outcome `absorbedByApproval` and the
    modal announces "your approval completed this; this submission moved
    nothing" — never the plain success screen, and never an auto-retry with a
    fresh key, because auto-resubmitting money after a race IS the
    double-deposit hazard. A second deposit stays a human decision. A REJECTED approval
    produces no movement, so its key survives until the next submit reuses it
    and the API answers 403 "denied by policy" — visible, and a 4xx retires the
    key, so the attempt after that mints a fresh one.
  - The entry cap governs EXPIRING entries only; a held entry is **never
    evicted**. The two are not comparable in either direction that matters: an
    expiring entry is minted by typing a new amount so it accumulates freely and
    costs at most a replay if dropped, while a held entry exists only because a
    real POST was parked by policy — single digits in practice — and dropping it
    mints a fresh key that opens a SECOND approval request for one intent. A
    shared cap traded the catastrophic failure for a storage one, and the storage
    one is not real at these sizes (~260 bytes an entry, so even a thousand held
    keys is a couple of hundred KB against a multi-megabyte quota); a refused
    write already fails soft into the in-memory tier.
  - The cap has a floor of ONE expiring entry, because callers write the entry
    they just claimed as the last element — a budget of zero would evict the key
    `claim` is about to return, and a key handed out but never stored is one the
    next call silently replaces.
  - Entries are zod-parsed per row on read, and the row type is derived from that
    schema — same convention as `deposit/earn-funding-wallets.ts`, and for the same
    reason: this store is untrusted JSON written as often by an older build of the
    page as by the current one.
  - A store that refuses every operation falls back to a module-scope map, so a
    dead store costs DURABILITY across a reload and never the answer to "is this
    the same request". Failing soft must not mean failing open.
  - A PARTIALLY dead store — quota: `setItem` throws while `getItem` keeps
    serving the stale previous state — is the trap in that design. Every write
    lands in memory unconditionally, so memory is always the newest complete
    snapshot and a readable storage can only be equal or OLDER; serving it after
    a failed write un-writes the just-claimed key (fresh mint → second approval)
    and loses hold markers (an executed approval presents as a fresh
    submission). A failed write therefore flips that store key to
    memory-preferred (`storageDivergedKeys`); the next successful write syncs
    the full snapshot back and returns authority to storage, so an external
    clear only ever means something when storage is actually keeping up.
    Residual, stated honestly: a failed write followed by a RELOAD serves stale
    storage — durability was refused, nothing client-side can close it — which
    is why the server independently re-checks every reused key.
  - It deliberately does NOT track which deposits are in flight any more. That
    was browser state pretending to be a ledger: it could not see a deposit
    signed in another tab, and it restored the previous project's watches after
    a workspace switch. `GET /v1/earn/vault-deposits` owns it now and is
    workspace-scoped by construction.

- `earn-vault-withdraw-modal.tsx` — the `vault_direct` EXIT (PRO-1702):
  redeem a position's shares back into the custody wallet that holds them,
  shares-denominated with a Max fill from the live position read (soft warning
  over the last observed balance — the network stays the authority). Mirrors
  the deposit modal's key lifecycle exactly, including the held-key pre-flight
  (`fetchEarnVaultWithdrawalsByRequestId`) and the absorbed-by-approval
  outcome. The result screen links the withdrawal transaction in Explorer.
  Exports `EarnVaultWithdrawalOutcomeTracker`, mounted once per withdrawal.
  Its five-second detail poll reports the terminal movement back to Treasury;
  Treasury keeps the latest state in the Active positions status column rather
  than announcing a long-running chain result with a toast.
- `earn-vault-withdraw-tracking.ts` — the withdrawal idempotency-key store
  (fingerprint: project, position, shares, minAmountOut — the derived exit
  floor is in there for the same reason the deposit's is) under its own
  versioned `sessionStorage` key.
- `earn-vault-slippage.tsx` — the slippage-floor machinery BOTH vault modals
  share: `parseSlippageToleranceBps`, `floorForTolerance` (BigInt at the quoted
  mint's scale, floored, one-atom minimum), `isSlippageExceededRefusal` (the
  API's `details.reason` seam), the debounced quote hook and the disclosure
  section. One copy on purpose — two copies of a funds-protection rule is how
  one drifts, the same reasoning as `earn-idempotency-key-store`. The floor is
  derived from a LIVE provider quote, never from the caller's own input; an
  unavailable quote DISABLES the action rather than guessing.
- `earn-idempotency-key-store.ts` — the shared machinery behind BOTH tracking
  modules (storage tiers, quota divergence, approval holds, entry bounds), plus
  `answerRetiresIdempotencyKey`, the shared retire-decision rule. Extracted
  when the withdrawal flow arrived; two copies of a double-spend guard is how
  one drifts.
- **The withdrawal outcome poll uses the UNIFIED ledger vocabulary**:
  `EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct` (`finalized | failed`),
  `confirmed` still in flight because `EarnVaultWithdrawal` speaks the
  ledger's own words. This is the OPPOSITE of the deposit poll's rule (legacy
  DTO, legacy terminal set); the two sets sit side by side in
  `earn-program-data.ts` with the reasoning attached to each.

## Where these seams are consumed — do not delete them as dead code

`useEarnPrograms`, `useEarnVaultPositions`, `useEarnVaultDeposits`,
`useEarnVaultWithdrawals`, `createEarnVaultDeposit`,
`createEarnVaultWithdrawal`, `useEarnVaultDepositOutcome`,
`useEarnVaultWithdrawalOutcome`, `isEarnVaultDepositInFlight`,
`isEarnVaultWithdrawalInFlight`, `earn-vault-deposit-tracking.ts`,
`earn-vault-withdraw-tracking.ts`, `EarnWithdrawModal`, `EarnVaultDepositModal`,
`EarnVaultWithdrawModal`, `EarnVaultDepositOutcomeTracker` and
`EarnVaultWithdrawalOutcomeTracker` have **no caller inside this module**. That is a module boundary, not an oversight: this module is the Earn
Program page (select a strategy → integrate the API), and the
surface that reads positions, opens the vault-deposit modal and drives
withdrawals is **Treasury Solutions**
(`../treasury-solutions/treasury-solutions-workspace.tsx`), which consumes all
of them. The deposit modal itself lives HERE, beside the strategy, decimal and
funding-wallet helpers it is built from, and is rendered from there.

Grep before deleting: a seam whose only caller is one directory over still looks
unreferenced from inside this one.

`createEarnVaultDeposit` rebuilds its request body field-by-field rather than
spreading the caller's input, so even an untyped caller cannot smuggle
`requestId` (the legacy custodial-program contract) or arbitrary fields into a
value-moving request. The RESPONSE is parsed at the boundary — a zod union over
the success envelope and the `SIGNING_PENDING` one, with the outcome type
derived via `z.infer` — so the deposit record itself is checked rather than
asserted. An approval hold is decoded into an explicit `approval_pending`
outcome (an approval is not a failure, and not a submitted deposit either) and
is accepted ONLY on a 202: created-and-held is a contradiction, and this must
not resolve it in the customer's favour.

`useEarnVaultDepositOutcome` keeps the deposit half of the polling pattern
`useEarnWithdrawalOutcomeToast` established, but owns no toast. It polls at 1s
for the first 15s, 2.5s through the first minute, then 5s until terminal, when
the interval becomes `0`. A ref guard makes `onSettled` fire exactly once, and
`undefined` args issue no requests. `onUpdated` projects every changed status
into Treasury's Active positions table without replacing settled content with
a skeleton; `onSettled` refreshes balances once the movement is done.
Terminal for a vault movement is `confirmed | failed`
(`EARN_TERMINAL_VAULT_MOVEMENT_STATUSES`) — note `pending` is NOT terminal: it
reads like a failure and is not one, it means SDP could not establish that the
transaction reached the network, which is the one case where the customer's
money is genuinely in the air. **Keep using
`EARN_TERMINAL_VAULT_MOVEMENT_STATUSES` here, not the similarly named
`EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct`** (PRO-1705): that one is the
unified ledger's vocabulary, where `confirmed` is NOT terminal because
`finalized` exists after it. This poll reads the legacy wire field, so switching
to the unified set would make it wait for a `finalized` nothing writes yet and
never stop. An unreadable poll returns `undefined` and keeps
polling; a read that failed says nothing about whether the deposit landed.

Two tiers, deliberately at different clocks, exactly as the withdrawal side
does it. `useEarnVaultDeposits` is the **discovery** tier at 30s — a cheap
server read that only decides WHICH deposits are worth watching, and the reason
a deposit signed before a reload, in another tab, or unblocked by an approval
minutes later becomes visible again. `useEarnVaultDepositOutcome` is the
adaptive **outcome** tier per watched deposit, self-stopping on terminal. Each
detail read is a scoped, fail-soft chain observation that advances the guarded
ledger row immediately; the scheduled reconciler remains the recovery path.
Do not collapse the tiers: one fast poll over the whole list would hammer a list
read that exists only to seed watches.

## Availability is the whole design

`earnVaultDepositAvailability` answers with a REASON, not a boolean, and every
surface renders that reason:

| Result | Means |
|---|---|
| `available` | this org can open this position, here, now |
| `cluster_unavailable` | the instrument lives on another cluster (`fundable: false`) — checked FIRST, and the badge names the row's `hostCluster` ("Mainnet only") instead of collapsing into a bare "Unavailable" (PRO-1742) |
| `strategy_unavailable` | inactive / not a `vault_direct` provider / provider not surfaced |
| `environment_unavailable` | the environment has no vault-direct deposits (`isVaultDirectDepositEnabled`) |
| `access_unavailable` | provider access could not be resolved — **fails closed** |
| `provider_unavailable` | resolved, but this org's provider entry is not enabled |

Two rules hold it together:

- **Static gates client-side, entitlement server-side.** Surfacing, deposit
  style and environment are static facts and may be read in the browser.
  Organization entitlement and provider configuration are request-scoped and
  must not be guessed there — they arrive as `providerAccess` from the server
  component, and `null` disables the action.
- **Disabled with an explanation beats hidden.** An unavailable strategy still
  renders its row, its APY and a badge naming why. Hiding it makes a customer
  hunt for a strategy they were shown yesterday.

`strategy.provider` is an OPEN read-model string (a TEXT column a newer deploy
may have written). Surfacing proves it is a registered provider before the cast
to `EarnProviderId`; an unknown value has already failed closed as
`strategy_unavailable`.

## Withdrawal rules

Measured against Ground sandbox 2026-08-13 (see `packages/sdp-earn/CLAUDE.md` →
Conventions). All still hold:

- **A 409 can be the answer.** The amount-less preview may refuse while still
  reporting the lane balance, so a 409 carrying
  `error.details.balance.withdrawableUsd` resolves the read instead of failing it.
- **`Max` floors to whole cents.** The reported figure is a balance, not a
  fillable amount — a lane reporting `20.001241` refuses exactly that and
  accepts `20.00`. Validation still permits the full figure, so this narrows
  what SDP offers, never what it allows.
- **An unresolved read never blocks the exit.** Pending or failed, the modal
  shows no number and validates shape only; the provider decides at confirm
  (ADR 0002 — money out must not gate on a read we could not complete).
- **Token lanes are per provider, not hardcoded.** The select renders
  `earnProgramSolanaPayoutTokens(provider)` from `@sdp/types` — the same
  registry the provider client gates on, so the button and the server cannot
  disagree. A token the provider never routes to Solana is NOT OFFERED at all.
  Do not reintroduce a module-level Ground-only constant here.
- **Never disable a money verb on status.** Withdraw gates on `withdrawableUsd`
  alone: the provider already reserves an in-flight amount out of that figure,
  so the balance expresses the constraint without a status lock that could trap
  an exit.
- Preview failures render TRANSLATED copy naming the per-lane reality — never
  the provider's wire text ("ground request failed with status 409" explains
  nothing).

## Money is a decimal STRING, end to end

The API deliberately carries amounts as strings, and JavaScript numbers cannot
distinguish every six-decimal value once balances exceed 2^53. So:

- `earn-decimal.ts` parses and canonicalizes without a `Number` cast, and
  delegates scale and ordering to `@sdp/solana/amount` (`decimalScale`,
  `compareDecimalAmounts`) rather than restating that arithmetic.
- `earn-format.ts` hands the decimal string straight to `Intl.NumberFormat`,
  which formats it exactly — no `Number` round trip, no manual grouping.
- `sumDecimalStrings` (`earn-market-presentation.tsx`) adds at the widest scale
  in `BigInt` and formats back.
- The one deliberate `Number` is `formatProviderApy`, on a RATE (`0.062`) rather
  than an amount, for `Intl.NumberFormat` percent output. Keep it that way.

Anything unparseable renders `—`. Never `0`, never a fabricated rate.

Shared machinery belongs OUTSIDE this directory: the modal focus trap lives at
`@/lib/use-modal-focus` (generic a11y, not Earn domain — its fallback attribute
is a plain parameter), beside `use-escape-key`. `Modal` still owns Escape.

## The client/server boundary bug — why `earn-surfacing.ts` exists

The surfacing constants live in **`earn-surfacing.ts`, which carries NO
`"use client"` directive**, and `earn-program-data.ts` merely re-exports them so
client callers keep one import site. Do not move them back.

They started in `earn-program-data.ts` (a client module). A Server Component
importing a *value* from a client module receives a **client-reference proxy,
not the value** — an object, so always truthy. `if (!EARN_PROGRAM_CREATION_ENABLED)`
was therefore dead code and the deposit route happily rendered the full wizard
with no provider that could create anything.

What makes this worth a section: **nothing catches it but a browser.** The types
are correct, so `tsc` passes; the unit tests mock the module, so they pass; lint
sees nothing. Any future server-side read of a dashboard constant belongs in a
directive-free module for the same reason — and a surfacing change wants one
browser pass on `/dashboard/markets/embedded-yield` and
`/dashboard/markets/embedded-yield/integrate`.

## Rules

- **Flags: declare in `src/flags.ts`, gate by segment.** `markets`
  (`MARKETS_ENABLED`) and `earn` (`EARN_ENABLED`) are `flagDefault(..., false)`
  declarations resolved in the dashboard layout and enforced once in the
  Markets segment layout (`../layout.tsx`). A bespoke env helper, a
  `process.env` read, or a `NEXT_PUBLIC_*` twin is wrong.
- **i18n: English only.** Edit `messages/en/dashboard-earn.json` (this module's
  copy is the `DashboardMarkets.earnProgram.*` and `DashboardEarn.*` namespaces;
  `DashboardMarkets.treasury.*` in the same file belongs to Treasury Solutions
  next door — one catalogue file, several surfaces); NEVER touch
  `messages/{es,fr,pt}` — or any future non-`en` locale — in the same PR. CI's
  Translation Catalog Policy fails a branch that edits English and localized
  catalogs together, because translations land on the automated release PR.
- **Solana-only surface**: only Solana deposit addresses/destinations render.
  Position labels arrive display-ready from the provider client — render
  `position.label` as given, and treat a chain name appearing in the UI as a
  provider-client bug, not something to patch here.
- **The catalogue shows strategies this module cannot select, on purpose.**
  Visibility and eligibility are different questions: a row is visible because
  the API returned it, and selectable because `earnVaultDepositAvailability`
  said so. Do not collapse them, and do not filter a row out of the table to
  express "not available" — that is what the badge is for.
- **Two visibility rules live in the API and this module never sees either.**
  `/strategies` omits Aave- and Morpho-related rows (`HIDDEN_STRATEGY_TERMS`)
  and every row of a provider SDP does not currently offer
  (`EARN_PROVIDER_SURFACING`), while the sync keeps storing both so the DB stays
  a truthful provider inventory. Do not reimplement either here: a client-side
  copy would drift, and a hidden row never reaches the browser to begin with.
- Design system: SDP quiet-institutional (see `.claude/skills/sdp-ui-designer`).
  Inter only — monospace is forbidden, including for addresses; use
  `tabular-nums` for numeric alignment. The ONE exception is a genuine code
  surface: the integration guide's `ui/code-block`, which is mono by design. Selection
  state is `border-primary bg-fill-subtle` across the whole module. `Badge` is
  status-only.
- **Nothing may overlap — provider and fund names run long.**
  `@solana/design-system`'s `cn` is a plain string join — **no tailwind-merge**.
  A class handed to `Table*` that conflicts with one of its own base classes
  does not win; it loses to CSS source order (`.whitespace-nowrap` is emitted
  after `.whitespace-normal`), and under `table-fixed` the still-unwrapped text
  overflows into the next column. Declare wrapping and clamping on the child
  spans, where nothing competes — that is why `EarnStrategyIdentity` clamps and
  truncates internally. Long text wraps inside a bounded clamp or truncates with
  a `title` carrying the full string; numbers never truncate.
- Provider-unconfigured (503) must degrade to a quiet notice, never crash. Note
  the asymmetry: the money-in writes answer 403 even for *missing credentials*,
  so read `error.code`, not just the status, before labelling a failure.
- Tests: vitest, `environment: "node"` by default — a test that touches
  `document` needs a `// @vitest-environment jsdom` docblock. Mock the data-hook
  seam (`./earn-program-data`), not fetch. Run:
  `pnpm --filter sdp-web exec vitest run src/app/dashboard/markets/earn`.
  CI runs them via the root `pnpm test` (`turbo run test` includes sdp-web).

## Running this locally

The web app alone shows nothing useful: the module needs the API, Postgres,
Redis, the flags, and live provider credentials. Full runbook — ports, env,
catalogue data, org entitlement, troubleshooting table:
`packages/sdp-earn/CLAUDE.md` → "Local development". The custody boundary and
each provider's on-chain flow: `packages/sdp-earn/README.md`.
