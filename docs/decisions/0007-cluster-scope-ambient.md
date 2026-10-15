# ADR 0007: Cluster scope is ambient facts; `@sdp/rpc` owns every chain client

- **Status:** Proposed
- **Date:** 2026-10-12
- **Deciders:** SDP engineering
- **Related:** HOO-1873, HOO-1874 (PR #2196); `packages/sdp-rpc`; `packages/sdp-fee-payment`; `apps/sdp-api/src/middleware/project-context.ts`; `apps/sdp-api/src/db/identity.ts` (ALS precedent)

## Context

One deployment serves Sandbox (devnet) and Production (mainnet) projects. RPC and Kora clients are built ad hoc from a process default (`SOLANA_NETWORK`, `createRpc(env)`, `defaultFeePaymentCluster(env)`), so a request or job for one project can silently read or send on the other cluster. `track-pending-transfers` checks every project's rows against one default client, so a mainnet signature looked up on devnet is marked failed as "not found". BYOK RPC is gone, so a client depends only on the cluster.

## Decision

- **Facts, not clients.** `@sdp/rpc` owns an AsyncLocalStorage store holding frozen `{ projectId | null, environment, cluster }`. `runInClusterScope({ projectId, environment }, fn)` is the only way to open a scope; it derives the cluster from the environment, so the cluster is never an input. `currentClusterScope()` reads the open scope. Hono `contextStorage()` is not used (it stores the whole Context and exists only inside requests).
- **One door.** `createClusterRpc()` takes no arguments and reads the scope; outside a scope it throws `SdpRpcError` `CLUSTER_SCOPE_MISSING`. The fee payer reads the scope at construction and stays per request (it carries `userId`). Helius DAS has its own getter over `SOLANA_RPC_HELIUS_<CLUSTER>_API_KEY_URL`. No function exposes pool URLs.
- **Consistent reads.** `withConsistentRpcReads(operation)` runs a multi-read operation on one endpoint and re-runs the whole operation on the next proven endpoint on transient failure, under one caller deadline, with a per-call cursor. Its client is typed without `sendTransaction`/`simulateTransaction`, so a re-run can never re-send. It replaces `apps/sdp-api/src/services/earn/vault-rpc-failover.ts`.
- **Consistent send.** Every submit goes through `withConsistentRpcSend` in `@sdp/rpc`. A required `beforeBroadcast({ signature, lastValidBlockHeight })` hook persists the attempt before the first send. Failover re-sends the same signed bytes only and never rebuilds. "Not found" is never terminal before expiry is proven (block height past `lastValidBlockHeight`, read from a provider whose `context.slot` is at or after the blockhash slot). It returns `confirmed` (signature, slot), `expired` (proven, so rebuilding is safe), or `pending` (deadline hit without proof; the reconciler continues from the stored signature). Rebuilding stays with the caller. Built on kit's send-and-confirm primitives if they already prove expiry (verify in `../kit` first).
- **Memoization.** Clients are memoized per process by cluster. Nothing below a memoized client reads ALS. The genesis probe runs under its own timeout and signal, never a caller's; a caller whose signal aborts stops waiting on the shared probe (kit's `getAbortablePromise`) while the probe continues for others.
- **Who opens a scope.** `runInClusterScope` is callable only from the project middleware, the job runner, webhook handlers, anonymous Earn, and tests, fenced by Biome `noRestrictedImports` (`allowImportNames` on `@sdp/rpc/scope`, with an override for tests and entry points). The middleware already resolves `{ projectId, environment }` and wraps `next` with it; work that starts from a row (`/pay`, webhooks and their replay) derives the facts through `clusterScopeForProject(projectId)` or the row's environment. Re-entering with equal facts is a no-op; differing facts throw `CLUSTER_SCOPE_CONFLICT`.
- **Packages.** Only the door reads the scope. Low-level helpers keep an explicit `rpc` parameter (Veda's `AsyncLocalStorage.snapshot()` fills run with no store). Every `env`/`cluster`/`rpcUrl` parameter and default cluster is deleted. Kamino, Veda and WisdomTree transport wrappers (timeout, socket retry, read de-duplication) move into `@sdp/rpc`.
- **Jobs.** Chain-touching jobs opt in and are registered once per cluster; the runner opens the scope, and each job selects rows by joining `projects` on environment. Requires `project_id NOT NULL`.
- **Enforcement.** Biome `noRestrictedImports` bans `createSolanaRpc*`, `createSolanaRpcFromTransport`, `createDefaultRpcTransport`, `createRpc`, `createJsonRpcApi` and `createSolanaRpcSubscriptions*` outside `packages/sdp-rpc`, tests included.
- **Deleted.** `SOLANA_NETWORK`, `resolveDefaultCluster`, legacy `createRpc(env)`, `createRpcForSdk`, `resolveClusterRpcUrls`, `getSolanaConfig`, the bare `KORA_RPC_URL` trio, and unsuffixed `SOLANA_RPC_HELIUS_URL`/`SOLANA_RPC_HELIUS_API_KEY`. Raw JSON-RPC `fetch` in `supply.ts` and `observed-transfers.ts` moves to kit methods.

## Considered Options

- **Clients on Hono `c.var`, threaded into services and packages**: rejected. Jobs have no `c`, and package-internal defaults (`native.adapter.ts`, `sdp-fee-payment/src/index.ts`) stay silent.
- **Every package reads the scope (no `rpc` params)**: rejected. Veda snapshot fills have no store, so ambient reads there throw.
- **Optional cluster argument on the door for jobs**: rejected. It can't be restricted to jobs and reintroduces a threaded choice.
- **One job pass per cluster inside a single job**: rejected for separate per-cluster registrations, which isolate claims, leases and provider outages per cluster.
- **Per-request pool failover for Earn**: rejected. One plan could mix provider views at different slots.

## Consequences

- `withConsistentRpcReads` and `withConsistentRpcSend` ship as sibling tickets under HOO-1873, built on the door, together with the Earn failover replacement and the `track-pending-transfers` fix. The HOO-1874 stack covers only the store, the door, the fee payer, the fence, the Biome ban and the deletions.
- Stack: #2196 (store, door, memoization) → in parallel: middleware and request call sites, per-cluster jobs, package wrapper moves, raw-fetch migration → deletions and the Biome rule last, landing with the final violation.
- Any cache or de-duplication key over scoped work must include the cluster.
