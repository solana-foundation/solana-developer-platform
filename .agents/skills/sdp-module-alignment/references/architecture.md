# Architecture checks (A1-A15)

API and package checks for one module. Each check gives the condition, where
the rule lives (cite it in the ledger, never restate it), how to verify, what
done looks like, and what Earn or DvP hit. IDs match `scripts/scan-module.sh`.

Paths: `api/` = `apps/sdp-api/src/`, `pkg/` = `packages/`, `web/` =
`apps/sdp-web/src/`, `adr/` = `docs/decisions/`. ADR numbers repeat (two 0005s,
two 0007s), so cite the file name and the bold bullet, for example
`adr/0007-cluster-scope-ambient.md` "Jobs".

## Contents

- A1 Release channel, module gate and dashboard gate
- A2 Cluster scope is the only cluster selector
- A3 One RPC door; packages take clients
- A4 RPC budget
- A5 Crons
- A6 Actions and credentials
- A7 Idempotency, API and dashboard
- A8 Money waists, sponsored sends and audit
- A9 Provider and RPC errors
- A10 Data model and migrations
- A11 Env keys and provider runtime
- A12 Code standards in the module
- A13 Reconcilers and observers
- A14 Tenant isolation
- A15 On-chain programs on every cluster

## A1 Release channel, module gate and dashboard gate

- **Condition:** the module has a maturity in `SDP_MODULE_MATURITY`
  (`pkg/sdp-types/src/release-channels.ts`), every route belongs to it in
  `api/routes/route-modules.ts`, and the router is mounted behind
  `requireModule("<module>")` in `api/app.ts`, ahead of any kill switch. The
  kill switch is whatever the module's gate function reads in
  `api/lib/feature-flags.ts` (DvP's `isDvpEnabled` reads the shared
  `MARKETS_ENABLED`); it never decides the release channel itself.
- **Dashboard gate:** the module's flag in `web/flags/definitions.ts`, and every
  nav item, tab, landing tile, filter or list that names the module comes from
  the channel-capped flags (`enabledTransactionModules(flags)`,
  `isModuleInDeploymentReleaseChannel`), never a raw tuple.
  `web/test/release-channel-flags.ts` and the stable-capped render tests (#2550)
  cover it.
- **Source:** `adr/0005-release-channels.md`; code-standards "Release-channel
  gating"; AGENTS.md "Public vs internal surfaces".
- **Verify:** scanner A1 prints the maturity, the mount line, the gate function,
  the env keys its kill switch reads and the dashboard flag. Issuance, custody
  and compliance mount behind `requireModule`; Earn, DvP, Private Channels and
  Rings use their own `require<Module>Feature`.
- **Done:** `v1.use("/<module>/*", requireModule("<module>"))` before the route,
  the kill switch after it; `api/routes/route-modules.test.ts` (each channel
  refuses the routes of a module it leaves out) stays green; a dashboard test
  renders with stable-capped flags.
- **Promotion is a maturity change**, never an env var. Dev runs
  `experimental`, stage and prod run `stable`, so `experimental` and `beta`
  modules serve on dev only. Probe before claiming where it runs:
  `curl -s -o /dev/null -w '%{http_code}' https://<host>/v1/<module>/<list-route>`
  (403 = off for that deployment, 401 = on).
- **Earn:** `requireEarnFeature` folds the channel into the flag (open). Stage
  sets `sdp_api_earn_enabled = "true"` while running `stable`, so stage 403s
  Earn: the channel wins.

## A2 Cluster scope is the only cluster selector

- **Condition:** every chain read, build and send reads its cluster from the
  open cluster scope (`currentClusterScope()`, `pkg/sdp-rpc/src/scope.ts`). A
  project's environment picks the cluster (sandbox = devnet, production =
  mainnet) and every deployment serves both. Nothing passes a cluster,
  environment, RPC URL or fee payer that the scope already holds, and API code
  never threads a client a callee could take from the door itself.
- **Package boundaries keep explicit clients.** Low-level package helpers take
  an `rpc` parameter, and the API hands them a door client: some package work
  runs with no scope open (Veda's snapshot fills), so a helper that read the
  scope would throw (`adr/0007-cluster-scope-ambient.md` "Packages").
- **Legacy selectors to remove:** `SOLANA_NETWORK`, `ENVIRONMENT` used as a
  network, `resolveDefaultCluster`, `getSolanaConfig`,
  `defaultFeePaymentCluster`, `resolveClusterRpcUrl(s)`, `SOLANA_RPC_URL`,
  `SOLANA_<CLUSTER>_RPC_URL`, `createRpc(env)`, `CLUSTER_BY_SDP_ENVIRONMENT`
  lookups inside services, `resolveSdpEnvironment(c)` threaded into services,
  and `env`/`cluster`/`rpcUrl` parameters (a package helper's `rpc` client
  parameter stays).
- **Who opens a scope:** the project middleware
  (`api/middleware/project-context.ts`), the cron runner, webhook handlers, the
  `/pay` context and tests. Never a service. Work that starts from a row opens
  it from that row's project and environment, as `api/routes/pay/context.ts`
  does with `runInClusterScope({ projectId, environment }, ...)`.
- **Source:** `adr/0007-cluster-scope-ambient.md` "Facts, not clients", "One
  door", "Who opens a scope"; code-standards "RPC and fee payment". The table
  there exempts legacy `createRpc` in DvP, issuance, Private Channels and Rings
  (HOO-1879): log those rows as exempt until promotion, not as passes.
- **Verify:** scanner A2 (three leads plus a `+` count of scope reads).
- **Done:** no legacy selector left, every entry point runs under a scope, and a
  boundary test like `api/services/earn/cluster-rpc.boundary.test.ts` fails a
  file that brings one back.
- **Mixed doors are the worst case.** A request runs under its project's scope
  and a per-environment cron opens one too, but a service that calls
  `createRpc(env)` ignores both and reads the process default (devnet on every
  deployment). DvP today: its writers (`services/dvp/create.ts`, `fund.ts`,
  `settle.ts`, `reclaim.ts`, `observe-now.ts`, the mint route) call
  `createRpc(env)`, while its reconciler (`services/jobs/reconcile-dvp-trades.ts`)
  reads `createClusterRpc()`. A production-project trade would be written on
  devnet and reconciled on mainnet. Fix by moving the writers to the door, or
  refuse the environment the module's program is not on (A15): a product call
  to make before the PR.
- **Earn:** 18 `createRpc(env, { rpcUrl })` sites and 25 resolver calls
  returned `""` for the non-default cluster, so production-project work on
  stage/prod read devnet or 503'd, a devnet block height fed a DELETE of
  production rows, and the mainnet mint-drift guard silently skipped. Fixed by
  #2535, #2544 and #2554.

## A3 One RPC door; packages take clients

- **Condition:** reads, builds and sends use `createClusterRpc()`, or
  `createClusterRpc({ timeoutMs })` for a client handed to a helper that sends
  without a signal; wallet signature history for observed transfers uses
  `createClusterHistoryRpc()`; Helius DAS goes through
  `api/services/helius-das.service.ts`. Packages take an explicit `rpc`
  parameter and build no client, transport, timeout or read-sharing wrapper of
  their own: those belong in `@sdp/rpc`. No web3.js `Connection`, no raw
  JSON-RPC `fetch`, no `createSolanaRpc*` or `createDefaultRpcTransport` outside
  `pkg/sdp-rpc`. Any cache or dedupe key over scoped work includes the cluster.
- **No module-only door.** If the door lacks something (consistent reads,
  consistent sends, a bounded client), extend `@sdp/rpc` with its owner. An
  interim module door is acceptable only with the RPC owner's OK and a ticket
  that deletes it; Earn's #2535 (interim) to #2544 (deleted) is that shape.
- **Source:** `adr/0007-cluster-scope-ambient.md` "One door", "Packages",
  "Enforcement"; code-standards "RPC and fee payment".
- **Verify:** scanner A3: own clients and raw JSON-RPC, plus signature-history
  reads (`getSignaturesForAddress`, `getTransaction`) on the plain client. Ask
  the RPC owner whether each history read needs the history pool; DvP's escrow
  history reads are that open question.
- **Done:** zero own-client hits outside `pkg/sdp-rpc`, the package's tests
  inject a client, and each history read has the owner's answer.
- **Earn (still open):** `api/services/earn/vault-rpc-failover.ts` and
  `earnClusterEndpointUrls`/`proveEarnClusterEndpoint` remain because Kamino,
  Veda and WisdomTree build kit clients from URL strings, Jupiter Lend uses a
  web3.js `Connection`, and Ondo, Hastra and `@sdp/earn` send raw JSON-RPC
  (HOO-1881 steps 3-4, HOO-2025 `withConsistentRpcReads`).

## A4 RPC budget

- **Condition:** every provider read, quote, build and job makes the fewest RPC
  calls that still read every value-bearing input live: one shared client per
  operation, static facts cached with a TTL that never stores a failure,
  independent accounts batched in one `getMultipleAccounts`, identical
  in-flight reads shared, no unfiltered `getProgramAccounts`, no unused
  `getBlockTime`/`getSlot`, no height read before the job knows it has rows.
- **Source:** AGENTS.md "RPC is a budget (hard rule)"; the checklist in
  `pkg/sdp-earn/CLAUDE.md` "RPC budget (hard rule)".
- **Verify:** scanner A4 lists scans and clock/height reads (most are needed;
  confirm each is used and comes after the row query) and counts RPC budget
  tests. Then count real requests per operation, warm and cold, with a fake
  transport or a recording fetch around the module's client, and pin them
  (`pkg/sdp-veda/src/sdk-rpc-budget.test.ts` is the pattern). A module with no
  budget test has never been measured: that is the finding.
- **Done:** before/after counts in the PR body and pinned by a test; outputs
  identical on identical inputs.
- **Earn:** Veda queue paths went from 22-68 requests to 2 (#2572), positions
  and builds from 5-32 to 2 (#2573); payment-request lanes stopped reading a
  height every 30 s with no rows (#2575). Still open: Veda's asset-mint cache
  fill runs an unfiltered `getProgramAccounts` once per cache window, and the
  door's 30 s genesis-proof TTL re-proves on nearly every cron tick.

## A5 Crons

- **Condition:** each job is a `defineCron` file (`api/cron/define-cron.ts`)
  with a `scope`. Anything that touches chain RPC is `scope: "cluster"`:
  registered once per environment, its own scope, selecting only that
  environment's rows. A `global` definition touches no shared cluster RPC.
  `enabled(env)` is decided at registration; every run logs `sdp_cron_run` with
  `environment`. Rows first: a height or status read comes after the row query
  says there is work.
- **Source:** `adr/0011-cron-definitions.md`; `adr/0007-cluster-scope-ambient.md`
  "Jobs" (rows selected by joining `projects` on environment, which needs
  `project_id NOT NULL`, see A10).
- **Verify:** scanner A5 lists each cron, its scope, its `// NOTE` count and the
  job it runs. Read each job body for chain reads and the rows-first order.
- **Done:** chain-touching crons are `cluster`, every claim and cleanup query
  filters by the scope's environment, ticks carry `environment`, and sdp-infra
  alert rules group by environment (E2). A module with no rules writes them;
  one with rules regroups them before the cron flips (sdp-infra #286 shipped
  before #2539), or liveness rules go blind for one environment.
- **Precedent:** DvP's reconciler is already conformant: `cron/dvp-trades.ts`
  is `cluster`, rows come first, every claim takes `environment` (#2414).
- **Today:** `cron/pending-withdrawals.ts` (Private Channels) and
  `cron/rings-indexing.ts` are `global` with a `// NOTE` explaining why; those
  notes are where their flips start. The Earn catalogue sync stays `global` as
  a recorded exception in `adr/0007-cluster-scope-ambient.md`.

## A6 Actions and credentials

- **Condition:** every route declares exactly one action with
  `requireAction("module.verb")` from `pkg/sdp-types/src/actions.ts`, or
  `publicRoute(reason)`. `read` views, `manage` edits SDP rows reversibly,
  `execute` is irreversible or leaves SDP, `configure` is provider or
  credential setup. Exits that return funds (cancel, reclaim) take `manage`.
  No permission strings checked in handlers (`callerMayPerform(c, action)` for
  mixed responses). Every route runs under project context: no anonymous or
  optional-auth path unless it is a reasoned `publicRoute`. A wallet-scoped key
  is honored wherever SDP signs (`api/routes/wallet-scope-route-inventory.test.ts`).
- **Source:** code-standards "One action per route"; AGENTS.md "Every route
  declares one action"; `adr/0007-money-admission.md` addendum (the credential
  decides exits).
- **Verify:** scanner A6; `api/routes/route-actions.test.ts`. Check each signing
  route's action is in its movement's actions (`pkg/sdp-types/src/movements.ts`),
  and read any "review before promotion" comment on an action.
- **Done:** route inventory green, every money route's action matches its
  movement, no optional-auth middleware in the module.
- **Earn:** a cancel route declared `earn.execute` while its movement needed
  `earn.manage` (#2533); keyless routes ran outside any scope until #2540.

## A7 Idempotency, API and dashboard

- **Condition:** mutating routes run validate, then `authorize(fn)` or
  `authorizeNone(reason)` (`api/middleware/authorize.ts`), then
  `idempotent({ key, serverErrors, recovery: "record" })`
  (`api/middleware/idempotency.ts`), then `replayFromRecord`
  (`api/middleware/movement-steps.ts`), then admission, then the handler.
  `recovery: "record"` is required wherever `replayFromRecord` is mounted: the
  route inventory refuses the pair without it, and on a `serverErrors: "store"`
  route a retry after a lapsed claim gets 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`
  instead of reaching the saved row. Money routes use `key: "required"`. The domain row is written
  under `getIdempotencyRecordKey(...)`, never the raw client key. Refusals use
  400 `IDEMPOTENCY_KEY_REQUIRED` and 422 `IDEMPOTENCY_KEY_REUSED`; replays carry
  `Idempotent-Replayed`. `authorize` checks access, never state.
- **Dashboard side:** every dashboard or BFF mutation on a keyed route sends or
  forwards an `Idempotency-Key` minted once per user intent (the mutation key
  store in `web/lib/dashboard-fetch.ts`), and keeps it across a 5xx retry.
- **Never:** a direct `Idempotency-Key` header read, a module replay table, a
  `requestGate` mixing access, state and replay, a body `requestId` used as the
  key, `replayFromRecord` without `recovery: "record"`, the step on a route
  whose response carries a secret, a key reuse answered 409, or a dashboard
  mutation sent with a bare `{ method: "POST" }`.
- **Source:** `adr/0009-idempotency-keys.md` (its Context names DvP, Earn,
  issuance and Private Channels as keeping their own handling); code-standards
  "Idempotency coverage"; AGENTS.md hard rule. Modules outside `stable` may keep
  their own handling (exempt until promotion), but
  `api/routes/idempotency-route-inventory.test.ts` fails the promotion until the
  shared step is mounted, so this is release work.
- **Verify:** scanner A7: direct header reads and `requestGate`, own key
  columns, 409 on key reuse, the `+` count of shared steps, and bare dashboard
  request inits. `api/routes/idempotency-key-reads.node.test.ts` pins the direct
  reads per file and only goes down.
- **Done:** zero direct reads (and the ratchet lowered in the same PR), the
  inventory test passes with the module treated as `stable`, and a same-key
  retry, a reused key with another body and a crash-then-retry each have a test.
- **Today:** DvP reads the header in four handlers, keeps its own replay
  tables, answers key reuse with 409, and its dashboard sends no key on settle
  and cancel (`markets/dvp/use-dvp-trade-actions.ts`). Issuance and Earn use
  `requestGate`; Private Channels reads the header directly.
- **Earn:** replay now runs before admission (#2533); the rest is HOO-2045
  (split `requestGate`) and HOO-2011 (mount the step).

## A8 Money waists, sponsored sends and audit

- **Condition:** custody signatures only through
  `createOrgSignerForCustodyWallet` (`api/services/solana/signer.ts`) naming the
  module's own movement from `MOVEMENTS`. Sponsors only through
  `createSponsorshipFeePayment(env, scope, movement, { custodyWalletId })` with
  `resolveRequestSponsorshipScope(c)` in a request or
  `resolveProjectSponsorshipScope(env, owner)` (refuses a project from another
  environment). Sponsored sends only through `submitSponsoredTransaction({
  feePayment, rpc: createClusterRpc(), transaction, lastValidBlockHeight, store
  })` (`api/services/sponsorship-submission.ts`) with a `SignedSubmissionStore`
  that persists the signature before the first send. Request code asks
  `isKoraSponsorshipConfigured(env)`; a cluster without Kora answers 503, never
  a wallet-pays fallback.
- **Admission:** a start whose first new signature goes through a waist is
  admitted there, at signing time (`api/services/sponsorship-admission.ts`, the
  custody signer). Only a start that signs nothing at all (a provider quote,
  session or payout) or runs without an authenticated actor (a job, `/pay`)
  calls `assertMoneyStartAdmitted` (`api/lib/money-admission.ts`) before its
  first provider call.
- **Interleavings:** for each money route, list the cases code-standards
  "Concurrency on money and external-spend paths" names (the same key
  concurrently, the same key with another payload, no key, a crash between each
  durable step, a definitive rejection, an ambiguous timeout, the reconciler
  racing the request, a retry after failure) and point at the claim,
  compare-and-set or test that settles each one.
- **Dropped broadcasts:** a send that RPC accepted can still be dropped. Name
  who re-sends the same signed bytes until confirmation or proven expiry (the
  submit loop, a read-through or the reconciler) and check it runs inside the
  blockhash lifetime (about 40 s on devnet): a reconciler that first looks at
  45 s is too late. "Not found" is never terminal before expiry is proven.
- **Audit:** money exits and admin actions write the audit ledger
  (`docs/ops/audit-ledger.md`; DvP's `recordDvpExitAudit` in
  `api/routes/dvp/trade-audit.ts`).
- **Never:** `signAsFeePayer` followed by your own send, Kora
  `signAndSendTransaction`, `createKoraAdapter`/`KoraClient`, reading
  `KORA_*_URL` yourself, or borrowing another flow's movement id. Marking a
  movement `exit` is a security-reviewed change.
- **Source:** `adr/0007-money-admission.md`; code-standards "Concurrency on
  money and external-spend paths", "RPC and fee payment", "Money admission",
  "Kora budgets"; AGENTS.md "Money moves only through the signing waists".
- **Verify:** scanner A8; `pnpm check:value-movement` (needs an installed
  workspace). Failure-path tests to copy: `api/services/dvp/create.test.ts`,
  `api/services/sponsorship.service.node.test.ts`.
- **Done:** zero A8 leads, `check:value-movement` green, a test proving a
  definite refusal releases the reservation, a named re-send path.
- **Precedent:** DvP's four sends already use `submitSponsoredTransaction` with
  a persisting store.
- **Earn (still open):** the last money path doing `feePayment.signAsFeePayer`
  plus its own broadcast (`api/services/earn/vault-execution.service.ts`), so a
  definite refusal leaves the reservation `charged_unknown` (PRO-1911);
  `isEarnVaultSponsorshipEnabled(env, cluster)` is a cluster-keyed copy of the
  Kora check; a dropped broadcast is never re-sent inside the blockhash window.

## A9 Provider and RPC errors

- **Condition:** provider and RPC responses are parsed with zod at the
  boundary; an upstream 5xx, 429, timeout, RPC failure or unreadable body is a
  retryable 503 with `Retry-After`, never a 400; a deterministic refusal (a
  policy or serialization rejection) is a non-retryable 4xx that releases any
  reservation; no `catch` swallows an RPC or provider error into a default
  (code-standards "No fallbacks"); third-party calls are instrumented
  (`instrumentVendorPort`, `logVendorCallFailure` in `api/runtime/vendor-calls.ts`;
  not applicable when the module calls no third-party API besides RPC); RPC
  outages carry a reason and cluster (HOO-1886 plans one `RPC_UNAVAILABLE`).
- **Source:** code-standards "Correctness" (no fallbacks), "TypeScript" (zod at
  the boundary); `adr/0009-idempotency-keys.md` (a 5xx is retryable, a refusal
  is stored for 24 hours, so a wrong 4xx sticks).
- **Verify:** scanner A9: 400s naming upstream failures, casts and
  `JSON.parse`, and every `catch` that does not bind its error.
- **Done:** each upstream failure class has a test asserting status and
  retryability.
- **Today:** DvP's `readMintDecimals` (`api/services/dvp/mints.ts`) turns any
  RPC error into `null`, which fund and reclaim answer as a 400.
- **Earn (still open):** Jupiter swap 5xx/429 answer 400; Kora -32092 maps to a
  retryable 503 with the budget left `charged_unknown` (PRO-2040).

## A10 Data model and migrations

- **Condition:** project-scoped tables have `project_id NOT NULL` (HOO-1966) so
  per-environment jobs can join `projects`; a child table without `project_id`
  is reached only through its parent row in the job's environment; soft delete
  only (`status = 'archived'`); status sets and every subset live once in
  `@sdp/types` and bind as parameters (`= ANY(?::text[])`), never SQL
  `IN ('a', 'b')` or a local `Set`; migrations pass `pnpm check:migration-compat`
  (indexes `CONCURRENTLY` alone in a non-transactional file, foreign keys
  `NOT VALID` then validated later).
- **Hard deletes:** code-standards "API" allows none. Whether claim rows
  (reservations, leases, unconsumed builds, provisional transfers) may be
  deleted is an open policy question: log each delete as open and raise it
  with the module owner instead of assuming an exception.
- **Source:** code-standards "TypeScript" (status sets), "API" (soft delete);
  `adr/0007-cluster-scope-ambient.md` "Jobs"; AGENTS.md "Migrations run while
  the previous revision still serves traffic"; `docs/ops/release-operations.md`
  "Schema compatibility".
- **Verify:** scanner A10: literals, hard deletes, nullable `project_id` in the
  module's CREATE TABLEs (it cannot see a later `SET NOT NULL`, so check newer
  migrations; a `PRIMARY KEY` column is skipped).
- **Earn (still open):** nine tables keep a nullable `project_id` plus their own
  `environment` copy (HOO-2177); 25 SQL `IN ('...')` literals.

## A11 Env keys and provider runtime

- **Condition:** every env key the API reads is in `api/types/env.d.ts`,
  `scripts/secret-keys.mjs` and `turbo.json` `globalEnv` (turbo drops
  undeclared keys locally). Provider adapters get a resolved runtime context
  (`{ mode, cluster, credentials }`, resolved once by the API as
  `api/services/ramps/runtime.ts` does), never the process env. Every
  deployment has both clusters' RPC pools and both Kora suffix pairs
  (`KORA_<CLUSTER>_URL` with `KORA_<CLUSTER>_RPC_URL`); no step "flips
  `SOLANA_NETWORK`".
- **Source:** AGENTS.md (env keys); code-standards "Ramp providers" (runtime
  context), "RPC and fee payment" (Kora config checked once at boot).
- **Verify:** scanner A11 diffs every key the module reads against the three
  lists. `ENVIRONMENT` or `SOLANA_NETWORK` showing up is also an A2 lead (Rings
  reads `ENVIRONMENT`).
- **Earn (still open):** `JUPITER_SWAP_API_URL` is missing from two lists.

## A12 Code standards in the module

- **Condition:** no `any`, no casts without a `SAFETY:` comment, zod at every
  trust boundary; mints and labels only from `@sdp/types/well-known-tokens`;
  program ids from `@solana-program/*` or the generated client, not literals;
  no duplicated shared helpers; no barrels, default exports or `../` imports
  (`adr/0010-module-boundaries.md`); `pnpm check:module-boundaries` and
  `pnpm check:well-known-mints` green.
- **Source:** code-standards "Correctness", "TypeScript".
- **Verify:** scanner A12 (type escapes, base58 literals; generated code and
  fixtures are skipped).
- **Earn (still open):** an `as any` in `vault-execution.service.ts`, three
  copies of `mapSettledWithConcurrency`, program ids in five provider files.

## A13 Reconcilers and observers

- **Condition:** every status the module reports from chain is an observation
  with a rule: it is read from the scope's pool at a known commitment, written
  with compare-and-set (`WHERE status = <the state it was computed from>`),
  and every intermediate state has a terminal rule and an owner that moves it
  (a cron, a read-through). Claims and leases release by proven expiry (block
  height past `lastValidBlockHeight`), not by timers. Sweeps are bounded per
  tick (batch size, history budget) and log a backlog.
- **Source:** code-standards "Concurrency on money and external-spend paths"
  ("Compare-and-set every transition", "Every intermediate state has a
  terminal rule", "RPC acceptance is not confirmation");
  `adr/0007-cluster-scope-ambient.md` "Consistent send".
- **Verify:** scanner A13 counts compare-and-set writes; then walk the status
  set in `@sdp/types` and name, for each status, who moves it out and what
  proves it.
- **Done:** a table of states, owners and proofs in the module's `CLAUDE.md`,
  and a test per terminal rule.

## A14 Tenant isolation

- **Condition:** every tenant-owned table has forced RLS; reads that cross
  organizations on purpose (a counterparty's view of a shared trade) have
  their own policy and tests and cannot be used as an enumeration oracle;
  in-request system grants are registered in `api/lib/tenant-boundary.test.ts`;
  every repository query is scoped by the authenticated tenant or parent id,
  with a cross-parent test.
- **Source:** `docs/ops/tenant-isolation.md`; code-standards "API" (child
  tables scoped by parent id); migration `0081_tenant_isolation_rls.sql`.
- **Verify:** scanner A14 lists the module's tables and any not named in a
  migration that forces RLS (0081 forces a list of tables in a loop). A table
  that was dropped later or holds no tenant data needs no policy: check before
  logging.
- **Done:** zero unlisted tenant tables; each cross-organization read has a
  test that a third organization gets nothing.

## A15 On-chain programs on every cluster

- **Condition:** each program the module calls is deployed, verified and
  IDL-published on every cluster its projects can reach (devnet for sandbox,
  mainnet for production), with upgrade authority handled per the Foundation
  SDLC (never moved to the multisig before deploy, verification and IDL
  publish). Until a program exists on a cluster, the API refuses that
  environment's projects before any work, and the dashboard copy says so
  truthfully.
- **Verify:** list the module's program ids (its package constants or
  generated client) and check each on both clusters; then confirm the refusal
  path with a test.
- **Today:** DvP's program is devnet-only (`api/routes/dvp/index.ts`, PRO-1798),
  yet the API has no explicit environment refusal while the dashboard warns
  that creating a trade "will be refused" on the wrong cluster. That gap and
  A2's mixed doors are the same decision.
