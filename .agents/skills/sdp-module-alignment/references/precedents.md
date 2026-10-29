# Precedents: Earn's alignment, fix order and the starting snapshot

Earn was the first module brought onto the current architecture and the
refresh design (October 2026). Its drift is the best predictor of what the
next module has: every item below was real, found by reading source, and most
have a PR to copy.

## Earn: what drifted and what fixed it

| Check | Drift | Fixed by | Still open |
|---|---|---|---|
| A2 | 18 `createRpc(env, { rpcUrl })` sites and 25 resolver calls; production-project work on stage/prod read devnet or 503'd | #2535 (managed pool per cluster), #2544 (every RPC via `createClusterRpc()`), #2554 (scope read at the decision point; boundary test) | none |
| A2 | Per-minute cleanup deleted production rows below a devnet block height; mainnet mint-drift guard silently skipped | #2535 (own pool, EXISTS gate) | none |
| A3 | Simulate, sign and broadcast pinned one URL; Earn kept its own genesis cache | #2535 | `vault-rpc-failover.ts`, URL helpers, provider packages building clients (HOO-1881, HOO-2025) |
| A4 | Veda 22-68 requests per queue op, 5-32 per position/build | #2572, #2573 (all to 2 warm) | asset-mint cache fill still runs an unfiltered `getProgramAccounts`; 30 s genesis TTL |
| A5 | Four `global` crons looped both environments per tick | sdp-infra #286 (alerts per environment), then #2539 | catalogue sync stays `global` (recorded exception in `0007-cluster-scope-ambient.md`) |
| A6 | Keyless routes ran outside any scope; a cancel route's action did not match its movement | #2540 (key on every route), #2533 (`earn.manage`) | none |
| A7 | Replay after admission; own `requestGate`, raw keys, 409 on reuse | #2533 (replay order) | HOO-2045, HOO-2011 |
| A8 | `signAsFeePayer` plus own broadcast; cluster-keyed Kora check | none | PRO-1911; dropped broadcasts never re-sent |
| A9 | Jupiter 5xx/429 answered 400; Kora -32092 a retryable 503 | none | PRO-2040 |
| A10 | Nullable `project_id` on nine tables; 25 SQL `IN` literals | none | HOO-2177 |
| A11 | `JUPITER_SWAP_API_URL` missing from two env lists | none | open |
| B1-B7 | Centred "Markets" header, 90rem frame, bordered cards, wide tables, custom stepper, uneven dialogs, phone actions off-screen | #2584 landing, #2585 Treasury, #2586 dialogs, #2587 Embedded Yield (on #2568's single design) | stale grant and fee copy |
| B8 | No API Playground tab | blocked by the public-surface hold (PRO-2038) | open |
| C1-C2 | 15 s and 30 s polls forever, per-row Kamino reads, double onboarding read | #2574 (76 to 21 requests per idle 5 min) | none |

## Fix order

This is Earn's order. Skip a step the module already satisfies (DvP's crons
and sends are conformant, and it has no anonymous paths), turn "regroup"
into "write" when the module has no alert rules, and settle any product
decision a step depends on first (DvP: refuse production projects until its
program is on mainnet, or move the writers onto the door).

API, one PR per step, each stacked on the last:

1. sdp-infra: regroup the module's alert rules by environment.
2. Crons to `scope: "cluster"`, every claim and cleanup filtered by the scope's
   environment.
3. Every request path under a scope: remove anonymous paths or open the scope
   at the entry point.
4. Door getters the module needs, added to `@sdp/rpc` with its owner.
5. Packages take clients instead of URLs.
6. Services and routes on `createClusterRpc()`, scope read at the decision
   point, threading deleted, boundary test added.
7. Fences and deletions: Biome bans, legacy env names, the module's exemption
   from the `createRpc` rule.

In parallel once step 6 lands: RPC budget per provider path (A4), the shared
idempotency step (A7), the sponsored-send waist (A8), error mapping (A9), data
model (A10).

Dashboard, one PR per surface: route scope and the landing or list page, the
main workspace, dialogs and shared pieces, then secondary pages and guides.
Land data-fetching changes (C) before the redesign stack or rebuild the stack
on them: #2574 and the Earn redesign conflicted.

## Lessons

- **Follow the module that already solved it.** Before designing a fix, check
  how payments, recurring or transfers do the same thing on main and copy it.
  The rule Earn was held to: no module-owned doors, caches or failover.
- **Notes rot in days.** Re-verify every claim against main and a live probe
  before it goes in a ledger or a ticket. Two of Earn's "open" items were fixed
  by the time they were re-checked.
- **Small fixes strand.** Earn's devnet audit produced a quick-fix batch (Kora
  error mapping, copy, badges) that sat uncommitted while the redesign stack
  merged over it. Land small fixes as their own PR first.
- **Run the money flows end to end.** The devnet run (deposit, partial and full
  exit, queued exit, in Treasury and the example app, with a request tap) found
  the dropped-broadcast gap, the Kora mapping and most copy bugs; unit tests
  found none of them.
- **Every PR states its tier and its RPC counts before and after**, even when
  the count does not change ("RPC counts unchanged on every path").

## Starting snapshot (2026-10-27, main d3a5ebfb2)

Scanner counts are leads, not findings. Re-run `scripts/scan-module.sh` before
trusting any row.

| Module | Maturity | `requireModule` | A2 legacy RPC | A5 crons | A7 own idempotency | Refresh pages |
|---|---|---|---|---|---|---|
| DvP | experimental | no (`requireDvpFeature` over `MARKETS_ENABLED`) | 8 `createRpc(env)` sites in the writers and the mint route; the reconciler reads the scope (mixed doors) | `dvp-trades` is `cluster`, conformant | four direct header reads, own replay tables, 409 on reuse; dashboard sends no key on settle and cancel | 0 of 3 |
| Issuance | experimental | yes | 11: `createRpc` in token handlers; sponsored sends on the process-default RPC | none | `requestGate` | 3 of 3 |
| Private Channels | experimental | no (`requirePrivateChannelsFeature`) | gateway `createRpc`, `CLUSTER_BY_SDP_ENVIRONMENT` in `project-rpc.ts`, raw JSON-RPC | `pending-withdrawals` is `global` (NOTE) | direct header read | 2 of 16 (connect form only) |
| Helius Rings | experimental | no (`requireHeliusRingsFeature`) | `createRpc` in `rpc-adapter.ts`, reads `ENVIRONMENT` | `rings-indexing` is `global` (NOTE) | none found | 0 of 1 |
| Compliance | experimental | yes | none | none | none | no dashboard pages |
| Earn | beta | no (`requireEarnFeature`) | provider packages only (A3) | 3 `cluster`, catalogue `global` | `requestGate`, raw `request_id` keys | 6 of 6 |
