# dashboard/markets/earn — agent notes

The Earn dashboard module. **All live data** — the mock seam is gone; do not
reintroduce fixture modules. Data flows: BFF proxies
(`src/app/api/dashboard/markets/earn/*` → `/v1/earn/*`) → SWR hooks → UI.

## Module map

- `layout.tsx` — the `earn()` flag gate (`notFound()`); `../layout.tsx` gates the
  whole Markets module the same way. Pages hold no flag checks — add new Earn
  routes under this segment and they inherit both gates.
- `earn-workspace.tsx` — overview: portfolio stat strip (total / earned /
  withdrawable), positions grouped by curator (compact disclosure rows),
  curator-grid onboarding hero (only when no program exists), withdraw entry.
- `earn-program-data.ts` — THE data seam. `useEarnProgram()` discriminates
  `404 → none`, `503 → unconfigured` (no provider key), `200 → active`;
  `useEarnStrategies()`, program upsert, deposits, withdrawal fetchers.
  `EARN_PORTFOLIO_PROVIDER` is the single deliberate Ground pin — widening to
  multi-provider selection happens HERE, not by scattering provider ids.
- `earn-program-presentation.ts` — pure presentation helpers over live
  `EarnStrategy[]` (curator grouping, APY ranges, monograms, profile copy).
- `earn-withdraw-modal.tsx` — portfolio-level withdrawal: amount + token +
  Solana destination; preview → confirm → submitted state.
- `deposit/` — wizard: curator (live catalogue) → allocation (per-token weight
  editors, 0.1 grid, sum 100) → review (create vs update copy — the org has ONE
  shared wallet) → funding screen (program status polling, Solana deposit
  address, live deposits feed).
- `earn-format.ts` — formatting utilities (APY, USD, token symbols).

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
- Design system: SDP quiet-institutional (see `.claude/skills/sdp-ui-designer`).
  Inter only — monospace is forbidden, including for addresses. Wizard steps
  must land pre-scrolled at top (useLayoutEffect reset — keep it).
- Provider-unconfigured (503) must degrade to the quiet notice, never crash.
- Tests: vitest; mock the BFF fetch layer (see earn-workspace.unit.test.tsx),
  not internals. Run: `pnpm exec vitest run src/app/dashboard/markets/earn`.

## Running this locally

The web app alone shows nothing useful: the module needs the API, Postgres,
Redis, the flags, and (for live data) a Ground sandbox key. Full runbook —
ports, env, catalogue data, org entitlement, troubleshooting table:
`packages/sdp-earn/CLAUDE.md` → "Local development". Ground's on-chain flow and
the custody boundary (SDP never signs): `packages/sdp-earn/README.md`.
