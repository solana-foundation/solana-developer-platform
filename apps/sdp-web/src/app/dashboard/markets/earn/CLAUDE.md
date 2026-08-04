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
  first, cash last), and a catalogue-fact onboarding hero shown only when no
  program exists. Deliberately **not** grouped by curator — see "One strategy,
  no curator step" below.
- `earn-program-data.ts` — THE data seam. `useEarnProgram()` discriminates
  `404 → none`, `503 → unconfigured` (no provider key), `200 → active`;
  `useEarnStrategies()`, program upsert, deposits, withdrawal fetchers.
  `EARN_PORTFOLIO_PROVIDER` is the single deliberate Ground pin — widening to
  multi-provider selection happens HERE, not by scattering provider ids.
- `earn-program-presentation.ts` — pure per-strategy helpers shared by every
  surface: token lane, settlement days, pool size, APY, curator/protocol labels,
  liquidity copy. Every one reads a field the provider actually publishes.
- `earn-withdraw-modal.tsx` — portfolio-level withdrawal: amount + token +
  Solana destination; preview → confirm → submitted state.
- `deposit/` — the deposit flow: funding wallet → profile → filtered strategy
  browse → review, then post-confirm outcome screens. See "The deposit flow".
- `earn-format.ts` — formatting utilities (APY, USD, token symbols).

## The deposit flow (`deposit/`)

Four wizard steps in `WizardFrame`, then one or two outcome screens. All of it
lives on the single `/dashboard/markets/earn/deposit` pathname — the shell's
full-height lock (`shouldUseWorkspaceViewport`) is an exact-equality check, so a
sub-route silently loses the sticky footer.

- `earn-deposit-wizard.tsx` — orchestrator: step state, submit, outcome routing.
- `earn-deposit-model.ts` — the pure model (profiles, filters, sorting,
  `singleStrategyAllocation`). No JSX, unit-tested.
- `earn-funding-wallets.ts` — org wallets via `/api/dashboard/wallets`.
- `wallet-step` → `profile-step` → `strategy-step` → `review-step`.
- `integration-screen.tsx` + `earn-api-snippets.ts` — the conditional API step.
- `program-live-screen.tsx` — deposit address, status, live deposits feed.
- `earn-deposit-chrome.tsx` / `earn-deposit-outcome.tsx` — shared primitives.

### One strategy, no curator step

The flow selects exactly ONE strategy and sends `pct: 100` for that strategy's
stablecoin lane. Curator-first selection and manual weight editing were removed
on purpose; curator is metadata rendered beside a strategy, never a gate. Do not
reintroduce a curator step, a weight editor, or curator grouping without
changing this note.

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

### Two conditions with no server state

- **Funding wallet** is a flow-level choice: `PUT /v1/earn/program` has no
  source-wallet field, and there is no API to move funds from an SDP wallet into
  the program. It shapes the funding instructions only — never imply a transfer.
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
  `messages/fr/*` (CI Translation Catalog Policy fails the branch).
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
