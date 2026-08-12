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
- `earn-workspace.tsx` — overview: ONE CARD PER PROGRAM, stacked as repeated
  records with no switcher (hiding a funded program behind a tab would make a
  reader hunt for money they hold). Each card owns its money tiles, its FLAT
  value-ordered holdings list (deployed slices first, cash last), its copyable
  deposit-address row (the funding loop without re-walking the wizard), and the
  two verbs that manage it — Withdraw, and Change strategy, which links to
  `deposit?program=<id>`. Above them, an aggregate portfolio strip (total /
  earned / withdrawable / blended APY, `portfolioTotals`) renders ONLY when
  there is more than one program: with a single program it would restate that
  card's own tiles directly above them. The blended APY is all-or-nothing — a
  portfolio where any funded program lacks a rate renders "—", never the rate of
  whichever programs happen to publish one. The section header's "Add strategy"
  button appears once at least one program exists and goes to the bare deposit
  path. The catalogue-fact onboarding hero renders
  ONLY once the program read RESOLVES with no programs (or `unconfigured`) —
  `undefined` is in-flight, and rendering on it flashed onboarding at program
  holders. Cash
  rows explain themselves from the target allocations (lane → strategy: deploys
  on rebalance; lane → cash: parked by design — Ground never converts between
  stablecoins). Zero-value NON-strategy slices never render — Ground keeps
  reporting a drained lane's residual cash bucket at $0 (provider plumbing,
  not a holding) — while nonzero value always renders whatever rail it sits
  on, so the list still sums to the wallet total. No share percents render —
  V1 is single-vault (PRO-1667) — and the provider-reported `pct` is ignored.
  Deliberately **not** grouped by curator — see "One strategy, no curator step"
  below.
- `earn-program-data.ts` — THE data seam. `useEarnPrograms()` reads the
  COLLECTION and resolves to `EarnProgramsState` — `{kind:"ready", programs}`
  (the array MAY be empty: that is how "this org holds no programs" arrives, and
  what drives the onboarding hero) or `{kind:"unconfigured"}` (upstream 503, no
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
  `EARN_PORTFOLIO_PROVIDER` is the single deliberate Ground pin — widening to
  multi-provider selection happens HERE, not by scattering provider ids.
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
  stablecoin Ground pays out on Solana. Every figure the modal quotes
  (available line, Max, amount validation, per-option amounts) is scoped to the
  SELECTED token via `withdrawLanes()` in `earn-program-presentation.ts`,
  because `withdrawableUsd` is wallet-level while Ground fills per lane —
  quoting the wallet figure let Max fill an amount the lane could never pay.
  Lane-unresolved value widens every lane's ceiling (never narrows), so an
  incomplete catalogue join degrades to the wallet-level figure; the preview
  stays the authority. A token Ground never routes to Solana (USDT: Ethereum
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

ONE route, TWO run shapes, FOUR user verbs. The verbs: **Set up Earn** (hero
CTA, no program yet), **Add strategy** (section button, once one exists),
**Change strategy** (program card button — the only one that carries a
`?program=`), and **Deposit** — which is NOT a wizard at all: it is the copyable
address row on the program card. Nothing in the UI may call the wizard a
deposit; it never moves money.

**The run's shape comes from the URL, not from whether the org happens to hold a
program.** With several programs legal, "a program exists" no longer says what
the user asked for — adding a second strategy and re-targeting the first are
different intents that look identical from that boolean.

- Add run (no `?program=`): wallet → strategy → review, then
  `POST /programs`. Serves the first program and every later one identically —
  "Set up Earn" and "Add strategy" are deliberately the same run, since a new
  program always wants funding context.
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
redemption-speed filter; yield is the APY sort. Neither assigns a synthetic
category, and copy must never imply that the provider rated anything.

Changing a filter clears a selected strategy if that row becomes hidden, so the
review step can never confirm a choice the reader can no longer see. Missing
pool size remains visible as `—` and sorts after reported values.

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
- Design system: SDP quiet-institutional (see `.claude/skills/sdp-ui-designer`).
  Inter only — monospace is forbidden, including for addresses; use
  `tabular-nums` for numeric alignment. The ONE exception is a genuine code
  surface: `deposit/integration-screen.tsx` renders `ui/code-block`, which is
  mono by design. Selection state is `border-primary bg-fill-subtle` across the
  whole module — do not mix in the issuance/ramps outline+ring variant. `Badge`
  is status-only; a plain label is an inline chip.
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
