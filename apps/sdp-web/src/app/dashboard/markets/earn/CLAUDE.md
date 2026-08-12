# dashboard/markets/earn — agent notes

The Earn dashboard module. **All live data** — the mock seam is gone; do not
reintroduce fixture modules. Data flows: BFF proxies
(`src/app/api/dashboard/markets/earn/*` → `/v1/earn/*`) → SWR hooks → UI.

## Module map

- `layout.tsx` — the `earn()` flag gate (`notFound()`); `../layout.tsx` gates the
  whole Markets module the same way. Pages hold no flag checks — add new Earn
  routes under this segment and they inherit both gates.
- `earn-workspace.tsx` — overview: portfolio stat strip (total / earned /
  withdrawable / APY), a FLAT value-ordered holdings list (deployed slices
  first, cash last), a copyable deposit-address row (the funding loop without
  re-walking the wizard), and a catalogue-fact onboarding hero. The hero renders
  ONLY once the program read RESOLVES to none/unconfigured — `undefined` is
  in-flight, and rendering on it flashed onboarding at program holders. Cash
  rows explain themselves from the target allocations (lane → strategy: deploys
  on rebalance; lane → cash: parked by design — Ground never converts between
  stablecoins). Zero-value NON-strategy slices never render — Ground keeps
  reporting a drained lane's residual cash bucket at $0 (provider plumbing,
  not a holding) — while nonzero value always renders whatever rail it sits
  on, so the list still sums to the wallet total. No share percents render —
  V1 is single-vault (PRO-1667) — and the provider-reported `pct` is ignored.
  Deliberately **not** grouped by curator — see "One strategy, no curator step"
  below.
- `earn-program-data.ts` — THE data seam. `useEarnProgram()` discriminates
  `404 → none`, `503 → unconfigured` (no provider key), `200 → active`;
  **polls while the provider is mid-operation** — cadence is a property of the
  WALLET (`earnProgramRefreshInterval`: `creating` 4s, `busy` 10s, everything
  else 0), never a caller flag, so a status can never sit frozen while money
  moves. It sets `EARN_PROGRAM_DEDUPING_MS` (2s) because the dashboard-wide
  `dedupingInterval` is 10s — equal to the busy cadence — and a poll landing
  inside its own dedupe window is dropped. `useEarnWalletActivityToasts()`
  announces a `busy → settled` transition ONCE, from observed provider state
  (never from what the user submitted), and only the workspace mounts it: the
  program read runs in several components and a toast per consumer would
  announce one completion several times. **It never announces a withdrawal**:
  the wallet only reports that the provider stopped, and a failed, cancelled or
  partial payout leaves it exactly as idle as a settled one — so
  `useEarnWithdrawalOutcomeToast(ref)` follows the WITHDRAWAL's own status
  instead (terminal = the shared `EARN_TERMINAL_WITHDRAWAL_STATUSES` from
  `@sdp/types` — completed / partially_completed / failed / cancelled — the
  same set the API's withdrawal ledger uses; `pending_approval` keeps waiting,
  since it still resolves). Only `completed`
  is a success toast — partial is a problem, not a win. Sourcing a settlement
  claim from a wallet transition is the bug to never reintroduce. SWR suspends
  polling for a hidden tab and revalidates on focus — which is why the cadence
  is unit-tested rather than checked in a browser;
  `useEarnStrategies()`, program upsert, deposits, withdrawal fetchers.
  `EARN_PORTFOLIO_PROVIDER` is the single deliberate Ground pin — widening to
  multi-provider selection happens HERE, not by scattering provider ids.
  `fetchEarnStrategies()` **pages** the catalogue: the API caps `pageSize` at
  100 and has no provider filter, so a single request silently dropped every
  strategy past the first page. It stops on a short page OR the reported total,
  with a hard page cap — keep all three.
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
- `deposit/` — the deposit flow: funding wallet → profile → filtered strategy
  browse → review, then post-confirm outcome screens. See "The deposit flow".
- `earn-format.ts` — formatting utilities (APY, USD, token symbols).

## The deposit flow (`deposit/`)

ONE route, TWO run shapes, THREE user verbs. The verbs: **Set up Earn** (hero
CTA, no program yet), **Change strategy** (program card button), and
**Deposit** — which is NOT a wizard at all: it is the copyable address row on
the program card. Nothing in the UI may call the wizard a deposit; it never
moves money.

- Setup run (no program): wallet → profile → strategy → review.
- Change-strategy run (program exists): profile → strategy → review — the
  wallet step is funding context and an update moves no funds, so it is
  omitted, and the review/summary rail show no wallet section.
- The wizard renders a route skeleton until the program read RESOLVES —
  rendering one shape and collapsing to the other is the hero-flash bug again.

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
- `earn-deposit-model.ts` — the pure model (profiles, filters, sorting,
  `singleStrategyAllocation`). No JSX, unit-tested.
- `earn-funding-wallets.ts` — org wallets via `/api/dashboard/wallets`.
- `wallet-step` → `profile-step` → `strategy-step` → `review-step`.
- `integration-screen.tsx` + `earn-api-snippets.ts` — the conditional API step.
  Snippets are Shiki-highlighted via `ui/code-block` → `lib/shiki-code`, the ONE
  shared css-variables theme (extracted from, and still used by, the API
  playground shell). Do not fork the theme.
- `program-live-screen.tsx` — deposit address, status, live deposits feed.
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

### Profiles are filters, never a risk rating

Ground publishes **no** risk tier, rating, grade, or score on a yield source —
its own docs say so, and `riskMetadata.riskTier` is written only by the local dev
seed. Profiles therefore compile to transparent filters over observable fields
(settlement speed, backing kind, pool size) and the UI says as much. Never ship
copy implying the provider rated anything.

The filter vocabulary intentionally mirrors Ground's
`POST /v2/wallets/strategy/optimize` constraints so a profile could later be
handed to that endpoint. That endpoint has **no** SDP surface today (no client
method, no route, no proxy) — wiring it is a three-layer build, not a swap.

A filter must never exclude on a field the provider left absent (an unreported
pool size passes every floor); the sandbox omits `tvlUsd` often enough that the
opposite choice empties the catalogue.

### Confirm is idempotent — keep it that way

The confirm sends a client-minted `requestId`, held per selected strategy in a
ref: a retry after a failed confirm replays the SAME key (the provider cannot
apply the change twice), and switching strategy mints a fresh one (reusing a key
with a different payload is a provider conflict). Dropping either half
reintroduces a double-submit that fires two provider mutations.

### The funding wallet is session-only, deliberately

Step 1 picks the wallet that stablecoins are sent FROM, keyed by
`custody_wallets.id`. It is **not persisted**, and that was a decision, not an
omission: `PUT /v1/earn/program` has no source-wallet field, and no API moves
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
  Note the asymmetry: `PUT /program` answers 403 even for *missing credentials*,
  so read `error.code`, not just the status, before labelling a failure.
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
