# @sdp/rpc

Solana RPC clients, the balance-read context, and the transport helpers every
provider read path is built from.

## Outbound pool

`apps/sdp-api/src/runtime/outbound-dispatcher.ts` installs one undici `Agent`
as the global dispatcher at API and job boot, so every `fetch` (kit, web3.js,
REST) shares it:

- `keepAliveTimeout` 19 s: past the ~16 s Treasury refresh and under a Solana
  RPC node's 20 s idle close, so steady refreshes reuse sockets (each closed
  socket holds a Cloud NAT port for 120 s).
- `keepAliveMaxTimeout` 60 s caps a server's Keep-Alive hint.
- No per-origin `connections` cap. A cap queues sends and builds behind a read
  burst to the same RPC, so never add one to the global pool.
- Installed only when the runtime's bundled undici major is 7, the major of the
  pinned npm `undici`. Any other major keeps Node's default pool and logs once.
  A Node bump that changes the bundled major also moves the npm pin and
  `PAIRED_UNDICI_MAJOR`.

## Dead-socket re-send

`withReadSocketRetry` (kit transports) and `fetchWithReadSocketRetry` (fetch
seams) re-send one JSON-RPC request once, at once, to the same URL, and only
when `fetch` rejected because the socket closed or reset before any response
(`UND_ERR_SOCKET`, `ECONNRESET`, "other side closed"). That is a pooled
keep-alive socket the server closed as it was reused.

- Re-sent: the plain reads in `READ_METHODS` (accounts, balances, blocks,
  slots, signatures, token reads).
- Never re-sent: `sendTransaction`, `simulateTransaction`, `requestAirdrop`,
  the blockhash and fee reads a transaction is built on (`getLatestBlockhash`,
  `isBlockhashValid`, `getRecentBlockhash`, `getFeeForMessage`,
  `getRecentPrioritizationFees`), unknown or provider-specific methods,
  batches, aborted requests, and a body that died after the headers
  ("terminated"). `socket-retry.test.ts` pins each.
- `createRpc` wraps every transport it builds, and `contextAwareRpcFetch` is
  `withRpcReadContextFetch(fetchWithReadSocketRetry)`. Both helpers are
  exported from `@sdp/rpc/read-context` and `@sdp/rpc/solana`.

## Read transport order

A provider read transport must compose, innermost first:

raw transport -> `withReadSocketRetry` -> in-flight dedup -> `withRpcReadContext`
-> deadline

Put the re-send below the dedup, so one re-send serves every joiner, and below
the read context, so a minimum-slot scope sees only the attempt that answered,
carrying the scoped payload. Sends, simulations and blockhash reads never take
a shared or re-sent path.

## Read floors

`readStamp()` is one process-local, strictly increasing clock.
`withReadFloor(floor, fn)` scopes a read, and `readFloor()` reads that scope.
An in-flight share of provider requests must stamp each request it sends and
let a caller join only a request stamped after the caller's floor, replacing
an older entry for later callers. Hydration runs each read under the stamp
taken right after its position rows were read, and reconciliation close-out
under a fresh stamp, so neither reuses a request sent before that point. A
floor does not make an RPC node current; the minimum-slot scope does.

## Earn's door (transitional, HOO-1881)

`createClusterRpc()` reads the cluster scope, but Earn still names its cluster:
the services the Earn crons share with request paths still take a cluster
(HOO-1881). The crons themselves run per environment in their scope since
HOO-2148 and read through `createClusterRpc()`. `factory.ts` therefore exports
three Earn-only functions, fenced by
Biome to `apps/sdp-api/src/services/earn/cluster-rpc.ts`:

- `createEarnClusterRpc(cluster, { timeoutMs? })`: the named cluster's managed
  pool. Without `timeoutMs` it is the very client `createClusterRpc()` returns
  in that cluster's scope; with one, a bounded client over the same pool
  transport, so failover, cooldowns and genesis proofs stay shared.
- `earnClusterEndpointUrls(cluster)`: the pool's URLs in failover order, or
  none. Earn's provider packages still build their own transports from a URL
  and pin one endpoint per operation, until `withConsistentRpcReads` (HOO-2025).
- `proveEarnClusterEndpoint(cluster, url)`: the pool's own genesis probe and
  proof cache for one of its URLs, so an endpoint the pool proved costs Earn no
  second probe, and the other way round.

All three answer the named cluster's pool or nothing, never another cluster's
and never `SOLANA_RPC_URL`, and throw `CLUSTER_SCOPE_CONFLICT` inside a scope for
the other cluster. Delete them once Earn reads the scope.
