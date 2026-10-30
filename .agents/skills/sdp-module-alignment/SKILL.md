---
name: sdp-module-alignment
description: Audit and plan bringing an SDP module (DvP, Issuance, Private Channels, Helius Rings, Compliance or a new one) fully onto the current SDP architecture and the 2026 refresh design, the way Earn was aligned in October 2026. Runs a scanner over the module's API, packages, dashboard, docs and sdp-infra, then walks a checklist (release-channel gate, cluster scope and RPC door, RPC budget, per-environment crons, actions, idempotency, money waists, errors, data model, reconcilers, tenant isolation, programs per cluster, refresh routes and page config, primitives, dialogs, skeletons, phone widths, copy, SWR polling, public surface, alerts) and produces a ledger plus a PR order. Use when asked to "bring DvP onto the latest architecture", "get Private Channels ready for stable", "what do we check before releasing Rings", "put Issuance fully on the refresh design", "promote a module", or "audit a module against SDP conventions". Not for a single bug fix or feature inside one module, or ramp provider work.
compatibility: Run from the solana-developer-platform repo. scripts/scan-module.sh needs bash 4.3+, git and Node 24+; the pnpm check scripts need an installed workspace; an sdp-infra checkout is optional (SDP_INFRA_DIR, default ~/sdp-infra).
---

# SDP module alignment

Checks one module against what the rest of SDP already does, then plans the
PRs that close the gap. "Aligned" means two things: the module uses the shared
mechanisms (cluster scope, one RPC door, per-environment crons, the shared
idempotency step, the signing and sponsorship waists, release-channel gating),
and its dashboard is on the refresh design with lean data fetching.

## When to use

- Bringing a module onto the current architecture, the refresh design, or both.
- Before promoting a module's maturity (`experimental` to `beta` to `stable`)
  or releasing it to a deployment that has not run it.
- Planning or reviewing the PR series for that work.

Not for one feature or bug fix inside a module (follow
`docs/contributing/code-standards.md` and the module's `CLAUDE.md`), and not
for ramp providers (`integrate-ramp-provider`).

## Defaults

- **Audit before fixing, read-only.** The scanner and the `pnpm check:*`
  scripts only read. The generators (`openapi:generate`,
  `route-actions:generate`, `generate:*`) write files: run them in the fix PR,
  never during the audit. Fix in the order in `references/precedents.md`, one
  PR per step.
- **Main and live probes are the source of truth.** Tickets, notes and earlier
  audits go stale within days; re-read every claim in source on main and probe
  deployed behavior. When a probe or a running app is not available, the row
  says Unchecked, never passed.
- **Shared mechanism, never a module copy.** When a shared piece is missing,
  extend it with its owner (`@sdp/rpc`, the idempotency middleware, the
  sponsorship waist). A module-only interim needs the owner's OK and a ticket
  that deletes it.
- **Cite, don't restate.** Each row names the rule by file and bold bullet
  (`docs/decisions/0007-cluster-scope-ambient.md` "Jobs", code-standards "RPC
  and fee payment"). ADR numbers repeat, so always use the file name.
- **Whole module scope:** routes, services, crons, jobs, repositories,
  migrations, packages, dashboard pages and BFF routes, shared area files (a
  Markets sub-module shares Markets files), docs, example apps, sdp-infra.
- **Tier by exposure at launch** (when the module reaches production's
  channel), and note the current exposure in the row: Critical (money or data
  on the wrong cluster, funds that can be lost or trapped), High (a money path,
  an AGENTS.md hard rule, no alerting on a money cron), Medium (a module copy
  of shared infrastructure, a page off the refresh design), Low (code
  standards, copy style). The check index gives each check's default.
- **Deliver the ledger in chat.** When it is long, also save it as an
  untracked markdown file outside the repo (a ledger is a dated snapshot, not
  repo docs). Turn open rows into tickets only when asked.

## Procedure

1. **Scope the module.** The scanner is `scripts/scan-module.sh` in this
   skill's folder (`.agents/skills/sdp-module-alignment/` in the repo, or
   `~/.claude/skills/sdp-module-alignment/` when installed for your user). Run
   it from inside any SDP checkout: it finds the repo root with git. Its header
   prints the directories it found, and it exits 2 on an unknown slug. Pass
   what the slug convention misses as extra paths: shared area files, a job
   named differently, a provider package.

   ```bash
   SCAN=~/.claude/skills/sdp-module-alignment/scripts/scan-module.sh  # or the repo copy
   "$SCAN" dvp
   ```

2. **Read every lead in source.** Re-run with every hit and keep the output out
   of the repo:

   ```bash
   MAX_HITS=200 "$SCAN" dvp \
     "apps/sdp-web/src/app/dashboard/[projectId]/markets/markets-route-skeletons.tsx" > /tmp/dvp-scan.txt
   ```

   A count is a lead, not a finding. Mark each hit drift, exempt (cite the
   exemption), conformant or noise. `+` rows count the shared mechanism in
   use; a zero there is the lead.
3. **Walk the manual checks.** Each reference section names what the scanner
   cannot see: rows-first job order, a route's action vs its movement, the
   money interleavings and re-send path, state owners, cross-organization
   reads, programs per cluster, phone widths, CLS, copy promises, alerts,
   live probes.
4. **Write the ledger** (template below), grouped by the index's areas.
5. **Order the PRs** with `references/precedents.md` ("Fix order"): skip steps
   the module already satisfies, and settle product decisions (refuse an
   environment or support it) before the PR that needs them. Each PR states its
   tier, RPC request counts before and after (or "unchanged") and what was not
   run.
6. **Re-run the scanner after each merge** and update the ledger; a step is
   done when its rows read Fixed on main.

## Check index

| ID | Area | Check | Default tier | Scanner | Reference |
|---|---|---|---|---|---|
| A1 | Release and gates | Maturity, `requireModule` mount, kill switch, dashboard gate | Medium | yes | architecture.md |
| A2 | Cluster and RPC | Cluster from the scope; no legacy selectors, threading or mixed doors | Critical | yes | architecture.md |
| A3 | Cluster and RPC | One RPC door; packages take clients; history reads; no module door | Medium | yes | architecture.md |
| A4 | Cluster and RPC | RPC budget: fewest calls, counts pinned by tests | High | leads | architecture.md |
| A5 | Crons and alerts | `cluster` crons for chain work, rows first, alerts per environment | High | yes | architecture.md |
| A6 | Auth and idempotency | One action per route, exits take `manage`, no anonymous paths | High | partly | architecture.md |
| A7 | Auth and idempotency | Shared idempotency step; dashboard sends the key | High | yes | architecture.md |
| A8 | Money path | Signer, sponsor and sponsored-send waists; admission; re-sends; audit | High | yes | architecture.md |
| A9 | Money path | Upstream failures 503, refusals 4xx, no swallowed errors, zod | High | leads | architecture.md |
| A10 | Data and config | `project_id NOT NULL`, soft delete, status sets in `@sdp/types` | Medium | leads | architecture.md |
| A11 | Data and config | Env keys in all three lists; runtime context, not process env | Low | yes | architecture.md |
| A12 | Data and config | No type escapes, literal addresses or duplicate helpers | Low | leads | architecture.md |
| A13 | Money path | Reconcilers: compare-and-set, terminal rules, proven expiry | High | partly | architecture.md |
| A14 | Data and config | Forced RLS, cross-organization reads, tenant-scoped queries | Critical | partly | architecture.md |
| A15 | Release and gates | Programs deployed and verified on every cluster, or refused | Critical | manual | architecture.md |
| B1 | Redesign | Every rewritten page in `REFRESH_ROUTES`, siblings tested out | Medium | yes | redesign.md |
| B2 | Redesign | Header page config: left title, page column, back and header actions | Medium | leads | redesign.md |
| B3 | Redesign | Refresh primitives replace cards, stat cards, wide tables, banners | Medium | leads | redesign.md |
| B4 | Redesign | Dialogs: `@sdp/ui/modal`, wizard progress, money never truncates | Medium | leads | redesign.md |
| B5 | Redesign | Skeletons hold the ready footprint; CLS 0 at 1440 and 390 | Medium | partly | redesign.md |
| B6 | Redesign | Copy in the area catalog, `check:i18n`, promises match the API | Low (Medium if copy promises behavior) | manual | redesign.md |
| B7 | Redesign | Phone widths: actions on screen, no scrolling tables | Medium | manual | redesign.md |
| B8 | Redesign | API Playground tab or a recorded reason it is blocked | Low | yes | redesign.md |
| B9 | Redesign | Tests, flow matrix, stage smoke specs, doc sync | Medium | partly | redesign.md |
| C1-C4 | Dashboard data | Polling shape, keys and batching, focus, measured counts | Medium | leads | dashboard-data.md |
| D1 | Docs and surface | Public OpenAPI and AI files follow the channel and holds | High (widening the surface) | partly | surfaces.md |
| D2-D4 | Docs and surface | Docs gating, partner material, repo docs | Low | partly | surfaces.md |
| E1-E3 | Release and gates | Channel and flags per deployment, alerts, live probes | High (missing alerts) | partly | surfaces.md |

## Ledger template

```markdown
# <Module> alignment ledger (<date>, origin/main <sha>)

## <Area from the index>

- **<What drifted, one line>** (<ID>, <tier>; today: <current exposure>). <file:line>. Rule: <file + bold bullet>. <Status>.
  - <Detail a fixer needs: the failing input, the measured count, the decision it waits on.>
```

Status is one of: **Fixed** (#PR), **Conformant** (never drifted, cite the
code), **Open** (ticket, or "no ticket"), **Exempt until promotion** (cite the
exemption; it still blocks promotion), **Unchecked** (what it needs: a browser,
a probe, an install). Earn's ledger in `references/precedents.md` is the
worked example.

## Errors and gotchas

### Scanner exits 2 with "No files found"
**Cause:** the slug matches no directory. **Fix:** use the slug the
module's folders use, or pass its paths explicitly.

### Scanner prints "could not evaluate theme-scope-routes.ts"
**Cause:** Node older than 24 cannot import a `.ts` file. **Fix:** use the
repo's Node (`engines` floor) and re-run; B1 needs it.

### Scanner prints "sdp-infra not found"
**Cause:** no checkout at `~/sdp-infra`. **Fix:** set `SDP_INFRA_DIR`, then
`git -C "$SDP_INFRA_DIR" fetch origin main` so the E rows read today's main.

### The reconciler reads the right cluster but the writers do not
**Cause:** mixed doors: writers call `createRpc(env)` (process default) while
the job reads `createClusterRpc()` (DvP today). **Fix:** A2 and A15 together;
decide whether to refuse the environment or move the writers first.

### The module 403s on stage even though its flag is true
**Cause:** the release channel wins over the flag (A1). **Fix:** nothing in
infra; promotion is a maturity change in `release-channels.ts`.

### A rewritten page still renders the base design
**Cause:** its path is not in `REFRESH_ROUTES`. **Fix:** add the regex and a
unit test row (B1); check the header config too (B2).

### No API Playground tab can be added
**Cause:** the family is not in the playground catalog, which follows the
public OpenAPI document. **Fix:** record the hold (B8, D1); publishing the
family is a security sign-off, not a dashboard change.

## References

- `references/architecture.md`: A1-A15, API, packages, data, programs.
- `references/redesign.md`: B1-B9, refresh pages, primitives map, dialogs,
  skeletons, copy, tests.
- `references/dashboard-data.md`: C1-C4, polling, batching, measurement.
- `references/surfaces.md`: D1-D4 and E1-E3, public surface, docs, partner
  material, sdp-infra, live probes.
- `references/precedents.md`: Earn's drift and fixes, the PR order, lessons,
  and the 2026-10-27 snapshot of every module.
- `scripts/scan-module.sh`: the first-pass scanner.
