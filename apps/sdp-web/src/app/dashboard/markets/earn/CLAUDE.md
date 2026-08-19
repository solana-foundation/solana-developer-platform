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
  vault-positions/route.ts           GET list (keyset cursor)
```

`provider-query.ts` holds TWO validators with deliberately different failure
modes. `programProxyQuery` is permissive-by-omission — an unrecognized param is
dropped — because those routes predate the typed client and are reachable with
arbitrary query strings. `vaultPositionsProxyQuery` is **strict**: it is
consumed only by our own typed client, so an unknown key, a repeated key, an
out-of-range `limit` or a non-base64url cursor **400s** instead of silently
reshaping the page. A typo must not return a different page of someone's money.

`proxyToSdpApi` never copies the inbound header bag — auth, project scope and
tracing stay server-owned — so a client-set `Idempotency-Key` never reaches the
API on its own. A route forwards one deliberately, per header, through the
optional `upstreamHeaders` argument, spelling it `IDEMPOTENCY_KEY_HEADER`
(`src/lib/idempotency.ts`). `vault-deposits/` is the one route that opts in,
forwarding that single header and nothing else; the program create still sends
the body `requestId` form.

## Routes

- `page.tsx` → `EarnProgramWorkspace` — the Earn Program page: pick a strategy
  from the live catalogue, then continue to the button builder.
- `button-builder/page.tsx` → `EarnButtonBuilder` — the customer-facing button
  preview plus a generated **server-side** integration snippet for
  `POST /v1/earn/vault-deposits`.
- Both are `dynamic = "force-dynamic"` and resolve `loadEarnProviderAccess()`
  server-side per request. Provider access is organization-scoped; caching it
  would hand one org's entitlement to another.
- `layout.tsx` — the `earn()` flag gate (`notFound()`); `../layout.tsx` gates
  the whole Markets module the same way. Pages hold no flag checks — add new
  Earn routes under this segment and they inherit both gates.
- Loading states come from `../markets-route-skeletons` (`EarnProgramSkeleton`),
  shared with the shell's navigation-loading resolver
  (`lib/dashboard-navigation-loading.ts` → the single `earn-program` route id
  covering both pathnames).

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
  routes to the builder with `?strategy=<id>`.
- `earn-button-builder.tsx` — re-checks availability itself rather than trusting
  the referrer, and refuses with a named empty state for each way in that can
  fail (catalogue error / unknown strategy / strategy not available). The style
  controls are **rendered disabled**: SDP has no button-configuration resource
  or client export yet, so they show the intended shape without pretending to
  save. The generated snippet is server-only and says so — it carries a secret
  API key.
- `earn-button-preview.tsx` — `EARN_BUTTON_STYLES` and the preview chip. The
  builder asserts its own options against that list at module load, so adding a
  style in one place and not the other throws instead of rendering a blank.
- `earn-program-data.ts` — THE data seam, over the BFF proxies above.
  `useEarnStrategies()` is what this module's pages read today; the program,
  vault-position and vault-deposit seams are documented under "Seams without a
  caller here". **No provider id is spelled in this file** — surfacing comes
  from `./earn-surfacing`, and reads are provider-agnostic on purpose so a
  position taken while a provider was offered stays visible after it is
  un-surfaced (ADR 0002 — un-surfacing closes the door in, never the door out).
  Both paginated readers **page to the end** and fail loudly rather than
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
- `earn-decimal.ts` — the strict decimal parser: digits required on BOTH sides
  of the point, optional no-trim and length caps, plus the canonical form. Scale
  and ordering are NOT reimplemented — `decimalScale` and `compareDecimalAmounts`
  come from `@sdp/solana/amount`. The one wrapper, `compareUnsignedDecimals`,
  exists because the shared comparator THROWS on a non-decimal and these call
  sites read provider strings during render (ADR 0002: a malformed ceiling must
  disable an affordance, never crash an exit).
- `earn-format.ts` — display formatters over decimal strings
  (`formatProviderAmount`, `formatUsd`, `tokenSymbol`, `formatTokenQuantity`,
  ISO-8601 duration helpers). `Intl.NumberFormat` takes the decimal string
  DIRECTLY (ES2023), so there is no `Number()` cast and no hand-rolled digit
  grouping; `roundingMode: "trunc"` because rounding a balance up would display
  an amount the provider then refuses. Every formatter takes the caller's
  `locale` — grouping and the decimal separator are locale facts, not en-US
  constants. A non-decimal input renders `—`; nothing invents a zero.
- `earn-market-presentation.tsx` — shared strategy identity + asset resolution
  (`EarnStrategyIdentity`, `earnStrategyAsset`, `formatProviderApy`,
  `sumDecimalStrings`). Shared with Treasury Solutions — keep it presentational.
- `earn-program-presentation.ts` — pure per-strategy helpers (token lane,
  source label). Every one reads a field the provider actually publishes.
- `deposit/earn-funding-wallets.ts` — the org's own SDP wallets, one inventory
  serving both deposit shapes. The response is zod-PARSED and the row type
  (`EarnFundingWallet`) is derived from that schema, so the two cannot drift; a
  row missing `publicKey` — the address a deposit is signed from — fails at this
  boundary instead of somewhere downstream. An invalid envelope THROWS; treating
  it as `[]` would disable deposits while claiming the org has no wallets. Only
  `active` wallets are returned — an inactive wallet cannot originate a
  transfer. `walletDisplayName` uses `||`, not `??`, so a whitespace label falls
  back instead of rendering an empty name.

## Seams without a caller here — do not delete them as dead code

`useEarnPrograms`, `useEarnVaultPositions`, `createEarnVaultDeposit` and
`EarnWithdrawModal` are exercised by unit tests in this PR and have **no product
caller in this module**. That is a stack boundary, not an oversight: this module
is the Earn Program page (select a strategy → build a button → integrate the
API), and the surface that reads positions, opens the vault-deposit modal and
drives withdrawals is **Treasury Solutions**
(`../treasury-solutions/treasury-solutions-workspace.tsx` and
`earn-vault-deposit-modal.tsx`), which lands in the next change on the stack.

The whole module is dark until then — `MARKETS_ENABLED` is `flagDefault(…,
false)` — so nothing ships half-wired. If you are reading this and Treasury
Solutions exists, these seams have callers and this section can go.

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

## Availability is the whole design

`earnVaultDepositAvailability` answers with a REASON, not a boolean, and every
surface renders that reason:

| Result | Means |
|---|---|
| `available` | this org can open this position, here, now |
| `strategy_unavailable` | inactive / not fundable / not a `vault_direct` provider / provider not surfaced |
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
browser pass on `/dashboard/markets/earn` and
`/dashboard/markets/earn/button-builder`.

## Rules

- **Flags: declare in `src/flags.ts`, gate by segment.** `markets`
  (`MARKETS_ENABLED`) and `earn` (`EARN_ENABLED`) are `flagDefault(..., false)`
  declarations resolved in the dashboard layout and enforced only by the segment
  layouts above. A bespoke env helper, a `process.env` read, or a
  `NEXT_PUBLIC_*` twin is wrong.
- **i18n: English only.** Edit `messages/en/dashboard-earn.json` (this module's
  copy is the `DashboardMarkets.earnProgram.*` namespace); NEVER touch
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
  surface: the builder's `ui/code-block`, which is mono by design. Selection
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
  CI does **not** run these: the root `pnpm test` is `turbo run test` and
  sdp-web declares `test:unit`, not `test`. Run them yourself.

## Running this locally

The web app alone shows nothing useful: the module needs the API, Postgres,
Redis, the flags, and live provider credentials. Full runbook — ports, env,
catalogue data, org entitlement, troubleshooting table:
`packages/sdp-earn/CLAUDE.md` → "Local development". The custody boundary and
each provider's on-chain flow: `packages/sdp-earn/README.md`.
