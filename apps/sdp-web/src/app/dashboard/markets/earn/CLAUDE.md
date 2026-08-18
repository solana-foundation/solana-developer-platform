# dashboard/markets/earn — agent notes

The Earn dashboard module. **All live data** — the mock seam is gone; do not
reintroduce fixture modules. Data flows: BFF proxies
(`src/app/api/dashboard/markets/earn/*` → `/v1/earn/*`) → SWR hooks → UI.

The proxy tree mirrors the API's collection shape (PRO-1670 — the old singular
`program/` folder is gone):

```
api/dashboard/markets/earn/
  provider-query.ts                  allowlisted query passthrough — lives at
                                     the earn/ ROOT because its importers now
                                     sit at several depths under programs/
  strategies/route.ts
  programs/route.ts                  GET list (page window) · POST create
  programs/[programId]/route.ts      GET one · PUT re-target
  programs/[programId]/
    deposits/                        GET (cursor)
    withdrawal-preview/              POST
    withdrawals/                     POST create · GET ledger list
    withdrawals/[withdrawalRef]/     GET detail
```

`proxyToSdpApi` forwards `{method, body}` and builds its own headers, so an
inbound `Idempotency-Key` never reaches the API — the dashboard's create sends
the body `requestId` form, which is the only one that can get through.

## Module map

- `layout.tsx` — the `earn()` flag gate (`notFound()`); `../layout.tsx` gates the
  whole Markets module the same way. Pages hold no flag checks — add new Earn
  routes under this segment and they inherit both gates.
- `earn-workspace.tsx` — the shared header-tab panel shell (see "Three tabs,
  one workspace") plus
  `EarnPositionsPanel`: ONE CARD PER PROGRAM, stacked newest first as
  repeated records with no switcher (hiding a funded program behind a tab would
  make a reader hunt for money they hold). Each card owns its money tiles, its
  FLAT value-ordered holdings list (deployed slices first, cash last), its copyable
  deposit-address row (the funding loop without re-walking the wizard), and the
  two verbs that manage it — Withdraw, and Change strategy, which links to
  `deposit?program=<id>`. Above them, an aggregate portfolio strip (total /
  earned / withdrawable / blended APY, `portfolioTotals`) renders ONLY when
  there is more than one program: with a single program it would restate that
  card's own tiles directly above them. The blended APY is all-or-nothing — a
  portfolio where any funded program lacks a rate renders "—", never the rate of
  whichever programs happen to publish one. The section header's "Add strategy"
  button appears once at least one program exists and goes to the bare deposit
  path. Cash
  rows explain themselves from the target allocations (lane → strategy: deploys
  on rebalance; lane → cash: parked by design — Ground never converts between
  stablecoins). Zero-value NON-strategy slices never render — Ground keeps
  reporting a drained lane's residual cash bucket at $0 (provider plumbing,
  not a holding) — while nonzero value always renders whatever rail it sits
  on, so the list still sums to the wallet total. No share percents render —
  V1 is single-vault (PRO-1667) — and the provider-reported `pct` is ignored.
  Deliberately **not** grouped by curator — see "One strategy, no curator step"
  below.
- `earn-opportunities-table.tsx` — the Opportunities tab's catalogue table (Deposit per row).
- `earn-playground.tsx` / `earn-playground-config.ts` — the Integrate tab.
- `earn-surfacing.ts` — `SURFACED_CUSTODIAL_EARN_PROVIDERS`,
  `EARN_PROGRAM_CREATION_ENABLED`, `EARN_PROGRAM_CREATE_PROVIDER`, all DERIVED
  from `@sdp/types` — no provider id is hand-set here. Deliberately has **no
  `"use client"`** so Server Components read real values; see "Browse-only mode".
- `earn-program-data.ts` — THE data seam. `useEarnPrograms()` reads the
  COLLECTION and resolves to `EarnProgramsState` — `{kind:"ready", programs}`
  (the array MAY be empty: that is how "this org holds no programs" arrives, and
  what empties the Positions tab) or `{kind:"unconfigured"}` (upstream 503, no
  provider key). There is deliberately **no `none` state and no 404 branch**: a
  collection cannot 404 for emptiness, and mapping 404 to "none" would let a
  retired path, a typo'd proxy path, or a missing Next route (which answers HTML,
  not our envelope) show onboarding to a customer with funds deployed — those
  throw and surface the retry UI instead. `hasPrograms()` / `findProgram()` are
  the accessors; nothing else may re-derive them.
  It **polls while any provider is mid-operation** — cadence is a property of the
  WALLET (`earnProgramsRefreshInterval`: `creating` 4s, `busy` 10s, everything
  else 0), never a caller flag, so a status can never sit frozen while money
  moves. One read serves every program, so the cadence is the FASTEST any single
  program asks for: taking the first program's or the slowest would strand
  exactly the program that is mid-operation.
  It sets `EARN_PROGRAM_DEDUPING_MS` (2s) because the dashboard-wide
  `dedupingInterval` is 10s — equal to the busy cadence — and a poll landing
  inside its own dedupe window is dropped. `useEarnWalletActivityToasts()`
  announces a `busy → settled` transition ONCE, from observed provider state
  (never from what the user submitted), and only the workspace mounts it: the
  program read runs in several components and a toast per consumer would
  announce one completion several times. It remembers the previous snapshot
  **per program id**, never as one previous wallet — with several programs a
  single remembered snapshot would compare whichever program was looked at last
  against a different one this pass, reading a busy→settled transition that
  never happened. **It never announces a withdrawal**:
  the wallet only reports that the provider stopped, and a failed, cancelled or
  partial payout leaves it exactly as idle as a settled one — so
  `useEarnWithdrawalOutcomeToast(programId, withdrawalRef)` follows the
  WITHDRAWAL's own status
  instead (terminal = the shared `EARN_TERMINAL_WITHDRAWAL_STATUSES` from
  `@sdp/types` — completed / partially_completed / failed / cancelled — the
  same set the API's withdrawal ledger uses; `pending_approval` keeps waiting,
  since it still resolves). Only `completed`
  is a success toast — partial is a problem, not a win. Sourcing a settlement
  claim from a wallet transition is the bug to never reintroduce. SWR suspends
  polling for a hidden tab and revalidates on focus — which is why the cadence
  is unit-tested rather than checked in a browser;
  `useEarnStrategies()`, `createEarnProgram` / `retargetEarnProgram` (two
  fetchers now, not one upsert — the verb is chosen by the caller, never
  inferred), deposits, withdrawal fetchers. Every per-program fetcher takes a
  `programId` and builds its path from it; none may fall back to "whichever
  program is first". `requestId` is REQUIRED on the write input — the API
  refuses a create carrying no idempotency key (PRO-1670).
  `EARN_PORTFOLIO_PROVIDER` is the single deliberate Ground selection/execution
  pin — widening to multi-provider deposits happens HERE, not by scattering
  provider ids. It is not a catalogue-visibility filter: browse-only providers
  still render in the strategy comparison table with disabled readiness states.
  Both it and `EARN_PROGRAM_CREATION_ENABLED` are re-exported from
  `earn-surfacing.ts` rather than declared here — a directive-free module, for a
  reason that is not cosmetic (see "Browse-only mode" below).
  `EARN_PROGRAM_CREATION_ENABLED` is **derived, never hand-set**:
  `isEarnProviderSurfaced(EARN_PORTFOLIO_PROVIDER)`. It is the one boolean every
  create affordance branches on.
  `fetchEarnStrategies()` AND `fetchEarnProgramsState()` both **page to the
  end**: the API caps `pageSize` at 100, and a single request silently drops
  everything past the window — for programs that is hidden MONEY (totals
  under-report, cards never render, deep links stop resolving). Each stops on a
  short page OR the reported total, with a hard page cap — keep all three.
  `fetchEarnProgramDeposits` has NO 404→empty mapping for the same family of
  reasons: its id always comes from the resolved list, so a 404 is a routing
  bug and must surface as the card's error state, never as "no deposits yet".
- `earn-program-presentation.ts` — pure per-strategy helpers shared by every
  surface: token lane, settlement days, pool size, APY, curator/protocol labels,
  liquidity copy. Every one reads a field the provider actually publishes.
- `earn-withdraw-modal.tsx` — portfolio-level withdrawal: stablecoin FIRST
  (it scopes everything below), then amount + Solana destination; preview →
  confirm → submitted state. The token always defaults to USDC — the one
  stablecoin Ground pays out on Solana.
  **Every figure it quotes comes from the PROVIDER, never from a local
  estimate** (PRO-1675). On open — and again on every token change — it fires an
  **amount-less** withdrawal preview for that lane; the answer drives the
  available line, `Max`, and amount validation. The old client-side
  `withdrawLanes()` join is deleted, and reintroducing any locally-derived
  ceiling is the regression to avoid: it is what let `Max` offer an amount the
  provider then 409'd. It takes NO props beyond `programId` for exactly this
  reason — balance and positions were only ever inputs to that estimate.
  Three rules hold this together, all measured against Ground sandbox
  2026-08-13 (see `packages/sdp-earn/CLAUDE.md` → Conventions):
  - **A 409 can be the answer.** Ground's amount-less preview may refuse while
    still reporting the lane balance, so a 409 carrying
    `error.details.balance.withdrawableUsd` resolves the read instead of
    failing it.
  - **`Max` floors to whole cents** (`floorUsdToCents`). The reported figure is
    a balance, not a fillable amount — a lane reporting `20.001241` refuses
    exactly that and accepts `20.00`. Validation still permits the full figure,
    so this narrows what SDP offers, never what it allows.
  - **An unresolved read never blocks the exit.** Pending or failed, the modal
    shows no number and validates shape only; the provider decides at confirm
    (ADR 0002 — money out must not gate on a read we could not complete).
  A token Ground never routes to Solana (USDT: Ethereum
  only, per their supported-chains doc — sandbox USDT is Ground's mock Sepolia
  asset) is NOT OFFERED at all: the token select renders only
  `SOLANA_PAYOUT_TOKENS`, mirroring `GROUND_SOLANA_ROUTED_TOKENS` in the
  provider client, which also keeps un-routable strategies out of the
  catalogue at sync time. Preview failures render TRANSLATED copy naming the per-lane
  reality — never the provider's wire text ("ground request failed with status
  409" explains nothing).
- `deposit/` — the deposit flow: funding wallet → full strategy catalogue →
  review, then post-confirm outcome screens. See "The deposit flow".
- `earn-format.ts` — formatting utilities (APY, USD, token symbols).

## The deposit flow (`deposit/`)

ONE route, TWO run shapes, THREE user verbs. The verbs: **Deposit** (an Opportunities
tab row — carries `?strategy=`), **Add strategy** (Positions section button,
once one exists), and **Change strategy** (program card button — the only one
that carries a `?program=`). The onboarding hero's "Set up Earn" is gone with
the hero.

**Nothing in the UI may call this wizard a deposit that MOVES money** — it never
does. It provisions a program; funding is the customer sending stablecoins to
the address on the program card afterwards. The Opportunities tab's Deposit verb is
named for what the reader wants, not for what the route executes, and the
simplified wallet → amount → summary → hand-off flow that would make that name
literal is NOT built yet (see the note at the end of this section).

**The run's shape comes from the URL, not from whether the org happens to hold a
program.** With several programs legal, "a program exists" no longer says what
the user asked for — adding a second strategy and re-targeting the first are
different intents that look identical from that boolean.

- Add run (no `?program=`): wallet → strategy → review, then
  `POST /programs`. Serves the first program and every later one identically —
  "Deposit" (from an Opportunities row, which pre-selects via `?strategy=`) and "Add
  strategy" are deliberately the same run, since a new program always wants
  funding context.
- Re-target run (`?program=<id>` resolves to a program): strategy → review,
  then `PUT /programs/:id` — the wallet step is funding context and a
  re-target moves no funds, so it is omitted, and the review/summary rail show
  no wallet section. An id that does NOT resolve is a full-screen stop notice
  with a back-to-Earn action, never a fallback: silently downgrading "change
  this program's strategy" to a create run would provision a second funded
  wallet the user did not ask for. The param is resolved by the SERVER shell
  (page.tsx) and passed as the `retargetProgramId` prop, same as `?strategy=` —
  search params belong to the page, the client wizard receives props.
- Which verb ran is decided by the URL, never inferred from the response — an
  explicit create that reported "not created" would be a contradiction, and the
  outcome screens carry the exact `programId` that was written so the live
  screen and the API snippets can never address a different program.
- The wizard renders a route skeleton until the program read RESOLVES —
  rendering one shape and collapsing to the other is the hero-flash bug again.
  A FAILED read renders the retry notice (same copy as the workspace), not the
  skeleton: state stays undefined on error, and an endless skeleton is
  indistinguishable from a slow load.

All of it lives on the single `/dashboard/markets/earn/deposit` pathname — the
shell's full-height lock (`shouldUseWorkspaceViewport`) is an exact-equality
check, so a sub-route silently loses the sticky footer. The header title
(`Shared.dashboardShell.earnNewDeposit` → "Earn strategy") is route-static and
deliberately neutral across both run shapes.

**Timing copy is bound to Ground's documented behaviour** (update-strategy +
deposits docs): targets save immediately; a LATER rebalance MAY move funds (no
cadence is promised — never write "scheduled" or "next pass"); slow strategies
can take hours; small balances may stay as cash on economic minimums. Every
sentence about timing must trace to one of those.

- `earn-deposit-wizard.tsx` — orchestrator: step state, submit, outcome routing.
- `earn-deposit-model.ts` — the pure model (filters, sorting,
  `singleStrategyAllocation`). No JSX, unit-tested.
- `earn-funding-wallets.ts` — org wallets via `/api/dashboard/wallets`.
- `wallet-step` → `strategy-step` → `review-step`.
- `integration-screen.tsx` + `earn-api-snippets.ts` — the conditional API step;
  the snippets print the just-written program's own
  `/v1/earn/programs/<programId>` paths, so they take a `programId` rather than
  assuming a singular program. Shiki-highlighted via `ui/code-block` →
  `lib/shiki-code`, the ONE shared css-variables theme (extracted from, and
  still used by, the API playground shell). Do not fork the theme.
- `program-live-screen.tsx` — deposit address, status, live deposits feed, all
  resolved from the `programId` the confirm returned.
- `earn-deposit-chrome.tsx` / `earn-deposit-outcome.tsx` — shared primitives.

### NOT BUILT: the simplified deposit run

The intended shape is **Deposit → wallet → amount → summary → hand-off**, and it
is not written. The Opportunities tab's Deposit link still enters the wizard above
(wallet → strategy → review). Two things constrain the design, both discovered
rather than assumed:

- **SDP has no code path that moves money into a vault, for either provider
  shape.** A custodial program is funded by the customer sending stablecoins to
  the program's address; a `vault_direct` vault is funded by the customer's own
  wallet signing an on-chain instruction. So the "amount" step is context for a
  hand-off, never an execution.
- **A `vault_direct` completion must never present the vault as a send target.**
  Kamino's `providerReference` is the vault's PROGRAM ACCOUNT — stablecoins sent
  there are lost. `earnDepositStyle` (@sdp/types) is what the completion step
  branches on, and the drift test in apps/sdp-api keeps it honest against the
  real `supportsPortfolioWallets` capability.

### One strategy, no curator step

The flow selects exactly ONE strategy and sends `pct: 100` for that strategy's
stablecoin lane — since PRO-1667 that is also the only shape the API accepts
(one allocation entry per token group). Curator-first selection and manual
weight editing were removed on purpose; curator is metadata rendered beside a
strategy, never a gate. Do not reintroduce a curator step, a weight editor, or
curator grouping without changing this note.

Omitting a token lane **preserves** it server-side (Ground: "the omitted group
is not changed"), which is why the review copy promises only the selected lane.

### Catalogue controls are filters, never a risk rating

Ground publishes **no** risk tier, rating, grade, or score on a yield source —
its own docs say so, and `riskMetadata.riskTier` is written only by the local dev
seed. There is deliberately no profile or bucket step: every active, fundable
strategy appears once in a comparison table. Liquidity is the explicit
redemption-speed filter; yield is the APY ranking. Neither assigns a synthetic
category, and copy must never imply that the provider rated anything.

Changing a filter clears a selected strategy if that row becomes hidden, so the
review step can never confirm a choice the reader can no longer see.

**Ranking is the reader's; the ordering rules are the model's.** Pool size and
APY are clickable column headers (`SortableColumnHeader` → `nextStrategySort`):
the active column flips direction, a newly clicked one opens descending, and
`aria-sort` on the `th` carries the state (the ARIA sortable-table pattern — no
separate live region). `sortStrategies` is the ONE comparator, and
`rankedFundableStrategies` is that function at `DEFAULT_STRATEGY_SORT` (APY
desc), so the step re-ranking the list it was handed is a no-op until a header
is clicked — do not add a second comparator. Two rules hold in BOTH directions:
an unreported figure stays visible as `—` and sorts LAST (an ascending pass must
not promote the rows we know least about above every row the reader can
compare), and ties break on name (the catalogue is re-read on revalidation, so
two 5.1% rows must not swap under the cursor). The sort is the step's own state,
not the wizard's: re-entering restores the default order, the way the step also
lands pre-scrolled at the top, while the selection belongs to the wizard and
survives wherever its row moves to. Backing and Access are labels, not rankings
— leave them unsortable.

### Confirm is idempotent — keep it that way

The confirm sends a client-minted `requestId`, held per selected strategy in a
ref: a retry after a failed confirm replays the SAME key (the provider cannot
apply the change twice), and switching strategy mints a fresh one (reusing a key
with a different payload is a provider conflict). Dropping either half
reintroduces a double-submit that fires two provider mutations — and on the add
run it would provision a second program the first deposit never reaches, which
is why the API makes the key REQUIRED on create (PRO-1670) and answers a replay
with 200 and the existing program instead of a duplicate.

### The funding wallet is session-only, deliberately

Step 1 picks the wallet that stablecoins are sent FROM, keyed by
`custody_wallets.id`. It is **not persisted**, and that was a decision, not an
omission: neither `POST /v1/earn/programs` nor `PUT /v1/earn/programs/:programId`
has a source-wallet field, and no API moves
funds from an SDP wallet into the program. A `funding_wallet_id` column was
built and reverted — its only consumer was preselecting the wallet on a return
visit, and provenance is already answered better by the deposit's own on-chain
`fromAddress`. Bring it back when something consumes it; defaulting the withdraw
modal's destination is the natural trigger. Until then the choice shapes the
funding instructions and nothing else — never imply a transfer happens.

### Conditions with no first-class data source

- **The API-integration screen** keys off "the org has active API keys", resolved
  in `page.tsx`. SDP persists no organization type, so this is a proxy for a
  B2B2C/API customer, not a real flag. If an org-type field ever lands, swap the
  prop. Snippets may only use routes that exist — there is no partner
  deposit-signing handshake in V1.
- Fireblocks is **not** custody-entitled by default, so the connect affordance is
  gated on provider availability; wallet setup also has no return-to plumbing, so
  never promise the reader they will come back mid-flow.

## Three tabs, one workspace

The tabs live in the dashboard HEADER: `getEarnRoutePageConfig` declares its
`headerTabs`, `DashboardHeaderTabs` owns the design-system tab semantics, and
`useDashboardTab` carries selection in the shallow `?tab=` URL state. The exact
Earn overview route is viewport-locked, and `EarnWorkspace` switches its three
independently padded/scrolling panels through `DashboardWorkspaceTabShell`.
There is no in-body `EarnTabBar` or second ARIA tabs contract.

- **Opportunities** (default) — `EarnOpportunitiesPanel` → `earn-opportunities-table.tsx`. The
  catalogue, ranked, with a Deposit link per row. It renders what the API
  handed it and NEVER re-applies a visibility rule; per-row depositability is a
  different question, answered by `opportunityDepositability`.
- **Active** — `EarnPositionsPanel` (the old `ProgramsSection`): one card per
  program, aggregate strip above when there is more than one, withdraw modal.
  Labelled "Active", keyed `positions`: the label is copy, the key names the
  concept the panel renders. The tab carries a live program count — the count
  is the point of the tab, answering "do I hold anything" without switching —
  published by `EarnWorkspace` via the generic `useHeaderTabCount("positions",
  …)` channel (a module-scoped store in `components/dashboard-header-tabs.tsx`,
  so a count change re-renders only the tab strip). Undefined while the read is
  in flight, so a loading state never renders as "(0)".
- **Integrate** — `earn-playground.tsx` (labelled "Integrate", keyed
  `playground`), modelled on
  `payments/counterparty/counterparty-playground.tsx` down to
  `ApiPlaygroundShell` + `PlaygroundApiKeySelector`. **Permanent reference, not
  a step in a flow** — it replaces the integration screen the wizard showed once
  after a create run, because a partner needs request shapes while building.
  Endpoints are fully curated in `earn-playground-config.ts` (the generated
  OpenAPI catalogue has no `earn` module yet).

The Opportunities and Positions panels are exported so unit tests can render
them directly instead of driving the shared header tabs.

**The Positions read is UNFILTERED by provider** (`fetchEarnProgramsState`). A
filter pinned to one provider hid money — a program from any other provider, or
from one no longer offered, simply vanished. The cost is narrow and documented
at the call site.

## Browse-only mode — when no provider can hold a program

**This is the shipped state as of 2026-08-14.** Ground is un-surfaced
(`EARN_PROVIDER_SURFACING` in `@sdp/types`) and Kamino, the only offered
provider, is catalogue-only — so nothing can create a program and Earn is a
comparison catalogue plus whatever programs already exist.

Everything branches on ONE derived boolean, `EARN_PROGRAM_CREATION_ENABLED`.
Never re-derive it from a provider id, and never add a second flag beside it:

| Surface | Creation enabled | Creation disabled |
|---|---|---|
| Opportunities tab | rows depositable per `opportunityDepositability` | unchanged — the catalogue is browse, not create, so it never gates on this |
| Active section header | "Add strategy" | hidden |
| Program card | Withdraw + "Change strategy" | Withdraw only |
| `/deposit` route | the wizard | `EarnDepositUnavailable` notice, returned by the server shell before it fetches anything |

Note the Opportunities row: `opportunityDepositability` asks THREE questions in order —
cluster, then token (both facts about the INSTRUMENT), then whether SDP has a
deposit path for the provider's shape at all (`no-sdp-route`).

**That third check is not optional, and omitting it shipped a dead end.** With
only cluster + token, a PRODUCTION Kamino row is fundable, holds USDC, renders an
enabled Deposit link — and lands on `EarnDepositUnavailable`, because the route
creates custodial programs only. Sandbox hides it, since every Kamino row is
`wrong-cluster` there, so this must be asserted in the model rather than checked
by hand (`earn-deposit-model.unit.test.ts`). Caught in review on #1340.

`no-sdp-route` carries the provider's `style` so the badge can name the real
reason: a `vault_direct` vault takes deposits from the customer's own wallet and
SDP does not route them yet, while a `custodial` one is simply not being offered.
Both answer "no" today.

**Withdraw is never gated on surfacing** (ADR 0002 — money out beats money off),
and the withdraw modal's focus-return fallback
(`data-earn-withdraw-focus-fallback`) therefore lives on the **Withdraw button**,
not on "Change strategy" which disappears with it.

The onboarding hero (`StartSection`) that used to own the "Set up Earn" CTA is
GONE — the Opportunities tab is the landing surface now, so there is no empty state to
route through. Its `startTitle`/`startStat*`/`browse*` message keys were removed
with it; do not reintroduce them without reintroducing the component.

### `earn-surfacing.ts` exists because of a client/server boundary bug

The surfacing constants live in **`earn-surfacing.ts`, which carries NO
`"use client"` directive**, and
`earn-program-data.ts` merely re-exports them so client callers keep one import
site. Do not move them back.

They started in `earn-program-data.ts` (a client module). `deposit/page.tsx` is
a **Server Component**, and a Server Component importing a *value* from a client
module receives a **client-reference proxy, not the value** — an object, so
always truthy. `if (!EARN_PROGRAM_CREATION_ENABLED)` was therefore dead code and
the deposit route happily rendered the full wizard with no provider that could
create anything.

What makes this worth a section: **nothing catches it but a browser.** The types
are correct, so `tsc` passes; the unit tests mock the module, so they pass; lint
sees nothing. The only signal was the wizard rendering when it should have
refused. Any future server-side read of a dashboard constant belongs in a
directive-free module for the same reason.

Unit tests cover both modes in one file: the mock of `./earn-program-data`
exposes `EARN_PROGRAM_CREATION_ENABLED` through a **getter** over a
`vi.hoisted` flag (a plain property would freeze the file into one mode), reset
to `true` in the top-level `beforeEach`. Note the mock's own limitation — it is
what hid the bug above, so a surfacing change wants one browser pass on
`/dashboard/markets/earn` and `/dashboard/markets/earn/deposit`.

## Rules

- **Flags: declare in `src/flags.ts`, gate by segment.** `markets`
  (`MARKETS_ENABLED`) and `earn` (`EARN_ENABLED`) are `flagDefault(..., false)`
  declarations next to the `privateChannels` precedent, resolved in the
  dashboard layout and enforced only by the segment layouts above. A bespoke env
  helper, a `process.env` read, or a `NEXT_PUBLIC_*` twin is wrong (the deleted
  `lib/earn-feature.ts` was all three).
- **i18n: English only.** Edit `messages/en/dashboard-earn.json`; NEVER touch
  `messages/{es,fr,pt}` — or any future non-`en` locale — in the same PR. CI's
  Translation Catalog Policy fails a branch that edits English and localized
  catalogs together, because translations land on the automated release PR.
- **Solana-only surface**: only Solana deposit addresses/destinations render.
  Position **labels arrive display-ready** — the provider client synthesizes them
  from kind + token precisely because a provider names a position after the chain
  its value sits on (`"USDT (Ethereum Sepolia)"`). Render `position.label` as
  given; never rebuild it from raw provider fields, and treat a chain name
  appearing in the UI as a provider-client bug, not something to patch here.
  A `cash` position can be a token the org never deposited on Solana, so do not
  assume positions imply a Solana deposit — only the addresses do.
- **The catalogue shows strategies this module deliberately cannot select.**
  Kamino is a catalogue-only provider: its K-Vaults are non-custodial — the
  customer's own wallet deposits. Each environment catalogues its OWN cluster's
  vaults (production → mainnet, everything else → devnet, read on-chain), so a
  sandbox row is a real, reachable devnet vault. They reach
  `GET /v1/earn/strategies` and the wizard's comparison table, but they must not
  advance to review because there is no program to create for them. TWO
  independent eligibility checks disable them, and both are intentional:
  - `EARN_PORTFOLIO_PROVIDER` — the existing Ground pin, which refuses selection
    for every non-portfolio provider while leaving its catalogue row visible.
  - `strategy.fundable` — the API's per-request answer to "does this instrument
    exist on the caller's cluster". Since Kamino catalogues per cluster this is
    now `true` in both environments, so it no longer disables anything for
    Kamino — the gate remains for Ground and any genuinely single-cluster
    provider. What disables the row is `no-sdp-route`: SDP has no deposit path
    for a `vault_direct` provider.

  Do not collapse visibility and eligibility. The pin is about which provider
  the flow can create a program with; `fundable` is about whether an instrument
  exists here at all, and it stops devnet money being pointed at a mainnet vault
  if the pin is ever widened. Neither should hide a real catalogue row.
- **A POSITION may name a vault the catalogue does not show, and that is not a
  bug here.** The two come from different places: positions are read live from
  Ground's wallet response, while the strategy table comes from
  `earn_strategies` filtered by API policy. So a program pointed at an
  Ethereum-hosted or an Aave/Morpho source still renders that vault's name under
  "Where the money sits", and real value sits in it. Do not filter such a
  position out of the UI: hiding a funded position hides customer money, which
  is worse than naming a vault the wizard would not offer. Clearing one means
  re-targeting the allocation in Ground (a money movement), not a web change.
- **Two more visibility rules live in the API, and this module never sees
  either.** `/strategies` list and detail omit Aave- and Morpho-related rows
  (`HIDDEN_STRATEGY_TERMS`) and every row of a provider SDP does not currently
  offer (`EARN_PROVIDER_SURFACING`), while the sync keeps storing both so the DB
  stays a truthful provider inventory. Those are server-side policy — one about
  a SOURCE, one about a PROVIDER — distinct from `fundable`, which is a fact
  about where an instrument lives, and from the provider pin, which is about
  what the flow can create.
  Do not reimplement it here: a client-side copy would drift, and a hidden row
  never reaches the browser to begin with. Same caveat as above applies — a live
  program POSITION may still name one of those sources, since positions come
  from Ground's wallet response and may hold real value.
- Design system: SDP quiet-institutional (see `.claude/skills/sdp-ui-designer`).
  Inter only — monospace is forbidden, including for addresses; use
  `tabular-nums` for numeric alignment. The ONE exception is a genuine code
  surface: `deposit/integration-screen.tsx` renders `ui/code-block`, which is
  mono by design. Selection state is `border-primary bg-fill-subtle` across the
  whole module — do not mix in the issuance/ramps outline+ring variant. `Badge`
  is status-only; a plain label is an inline chip.
- **Nothing may overlap — provider names run long.** Two traps, both sprung by
  "Janus Henderson JTRSY tokenized by Centrifuge":
  - `@solana/design-system`'s `cn` is a plain string join — **no
    tailwind-merge**. A class handed to `Table*` that conflicts with one of its
    own base classes does not win; it loses to CSS source order
    (`.whitespace-nowrap` is emitted after `.whitespace-normal`), and under
    `table-fixed` the still-unwrapped text overflows into the next column. The
    strategy table therefore declares wrapping and clamping on the child spans,
    where nothing competes. Never assume an override of a DS base class took —
    and watch for the same trap with `display` (`block` vs `line-clamp-*`).
  - `SummaryRow` gives the LABEL `shrink-0` and the VALUE `ml-auto min-w-0
    break-words`. The inverse — a `shrink-0 whitespace-nowrap` value — is what
    drove a fund name back over its own label: `justify-between` distributes
    NEGATIVE free space, so a value that cannot shrink overlaps rather than
    merely overflowing. Mirrors `payments/wizard-summary-list`.

  Long text wraps inside a bounded clamp, or truncates with a `title` carrying
  the full string. Numbers never truncate — wrap them instead.
- Steps must land pre-scrolled at top (useLayoutEffect, `behavior: "instant"`,
  then focus the first `h2` — keep it). `WizardFrame` owns the only scroll
  container AND already renders the step `h2` + description, so step children
  must add neither.
- Provider-unconfigured (503) must degrade to the quiet notice, never crash.
  Note the asymmetry: the money-in writes (`POST /programs`,
  `PUT /programs/:programId`) answer 403 even for *missing credentials*, so read
  `error.code`, not just the status, before labelling a failure. The programs
  LIST answers 503 for the same condition — and does so even when the org holds
  nothing, which is why an empty list may be read as "no programs" without
  checking anything else.
- Missing numbers render "—", never `0` and never a fabricated rate.
- **The provider is the source of truth for what is happening to the money.**
  The status chip names the operation from `wallet.activity` — the
  provider-neutral field the provider client derives in ONE place (Ground:
  `WALLET_STATE_BY_GROUND_STATUS`) — never from a raw provider status string,
  and never inferred from what the user just submitted. A busy state the client
  does not recognize arrives with no activity and falls back to the generic
  label rather than being guessed at. Adding a second copy of a provider's
  vocabulary to this module is the mistake to avoid.
- **Never disable a money verb on status.** Withdraw gates on
  `withdrawableUsd` alone (ADR 0002, money out beats money off): the provider
  already reserves an in-flight amount out of that figure, so the balance
  expresses the constraint without a status lock that could trap an exit —
  including when an unrecognized status normalizes to `busy` indefinitely.
- Tests: vitest, `environment: "node"` by default — a test that touches
  `document` needs a `// @vitest-environment jsdom` docblock. Mock the data-hook
  seam (`./earn-program-data`), not fetch. Run:
  `pnpm --filter sdp-web exec vitest run src/app/dashboard/markets/earn`.
  CI does **not** run these (sdp-web has no `test` script) — run them yourself.

## Running this locally

The web app alone shows nothing useful: the module needs the API, Postgres,
Redis, the flags, and (for live data) a Ground sandbox key. Full runbook —
ports, env, catalogue data, org entitlement, troubleshooting table:
`packages/sdp-earn/CLAUDE.md` → "Local development". Ground's on-chain flow and
the custody boundary (SDP never signs): `packages/sdp-earn/README.md`.
