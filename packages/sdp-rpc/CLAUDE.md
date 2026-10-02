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
  `withRpcReadContextFetch(fetchWithReadSocketRetry)`. Providers import both
  helpers from `@sdp/rpc/read-context` (or `@sdp/rpc/solana`).

## Read transport order

Any provider read transport composes, innermost first:

raw transport -> `withReadSocketRetry` -> in-flight dedup -> `withRpcReadContext`
-> deadline

The re-send sits below the dedup, so one re-send serves every joiner. It sits
below the read context, so a minimum-slot scope sees only the attempt that
answered, and that attempt carries the scoped payload. Sends, simulation and
blockhash reads never go through a shared or re-sent path.

## Read floors

`readStamp()` is one process-local, strictly increasing clock.
`withReadFloor(floor, fn)` scopes a read, and `readFloor()` reads that scope.
Every in-flight share (the Kamino, Veda and Jupiter Lend RPC dedups and the
Jupiter Lend liquidity catalogue) stamps each request it sends and lets a
caller join only a request stamped after the caller's floor; an older entry is
replaced for later callers. Hydration runs each read under the stamp taken
right after its position rows were read, and reconciliation close-out under a
fresh stamp, so neither reuses a request sent before that point. A floor does
not make an RPC node current; the minimum-slot scope does. A new share must
follow the same rule.
