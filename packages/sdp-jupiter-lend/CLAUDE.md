# @sdp/jupiter-lend: agent notes

Vault-direct client for Jupiter Lend's USDT earn market (jlUSDT), mainnet only.
It reads positions, quotes and builds unsigned plans through the pinned
`@jup-ag/lend` SDK; it never signs or submits. The RPC budget rule in
`packages/sdp-earn/CLAUDE.md` applies to every path here.

## One read Connection per RPC URL (`src/rpc.ts`)

`jupiterLendConnection(url)` keeps one web3.js Connection per URL (the 32 most
recently used) for reads, quotes and builds. Its fetch chain, outermost first:

- `withRpcReadContextFetch`: scoped reads carry and validate their minimum
  slot.
- `withJupiterLendReadSharing`: identical in-flight reads (`getAccountInfo`,
  `getMultipleAccounts`, `getProgramAccounts`, `getTokenAccountBalance`,
  `getTokenSupply`) share one request, keyed by the endpoint's hash (RPC URLs
  carry API keys) and any minimum slot. A caller joins only a request sent
  after its read floor (`packages/sdp-rpc/CLAUDE.md`, "Read floors"). Nothing
  is kept once a request settles; a request carrying a signal is never
  shared.
- `fetchWithReadSocketRetry`: one re-send when a pooled socket died, which
  serves every joiner.

429s keep web3.js's default retries (5 attempts, 500 ms doubling) for reads and
builds before an error reaches the vault failover runner. Do not set
`disableRetryOnRateLimit`: on a single-URL deployment one transient 429 would
fail an exit build outright.

## The getProgramAccounts shim

`getLendingTokenDetails` finds the lending account with `getProgramAccounts`
on the lending program, filtered by memcmp@0 `PiDuNSLmEPr` (the discriminator)
and memcmp@40 jlUSDT. `JupiterLendConnection` answers exactly that query (no
other config keys) with one `getAccountInfo` of the PDA [lending, USDT, jlUSDT],
`F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE`, checked against owner,
discriminator and fTokenMint. Any mismatch runs the real scan.

- Premise: only that PDA can match. `init_lending` creates every lending
  account at [lending, mint, f_token_mint], and jlUSDT is itself the PDA
  [f_token_mint, USDT].
- Not yet observed on mainnet. Before launch, run that exact query once,
  read-only, and confirm it returns exactly the address above.
- `sdk-coupling.test.ts` pins the SDK's query; an SDK bump that changes it
  falls back to the scan.

## Pinned mints

Builds hand the SDK `withPinnedMintOwners(connection)`: its reads of the USDT
and jlUSDT mints are answered from constants (owner Tokenkeg; the SDK reads
only `owner`, pinned in `sdk-coupling.test.ts`). Every other read is live,
including the SDK's own ATA read, whose `.catch(() => null)` still decides the
idempotent ATA create. So an RPC failure on that read plans a create and can
report `createsShareAccount: true` for an existing account, as the SDK always
has.

## Position read

The jlUSDT balance is decoded from the share ATA's `getAccountInfo` bytes and
accepts what `getTokenAccountBalance` reads there: an initialized or frozen
Tokenkeg jlUSDT account, whatever its token owner (Tokenkeg lets an ATA's owner
be reassigned). A missing account is a confirmed zero; anything else is
unreadable, never zero. Concurrent reads share one in-flight withdrawal
liquidity request to lite-api, under the same read-floor rule.

## Request budget (pinned in `sdk-coupling.test.ts`)

| Operation | Before | Now |
|---|---|---|
| Holder read | 13 RPC + 1 REST | 7 RPC + 1 REST |
| Three holders read together | 39 + 3 | 9 + 1 |
| Deposit quote, withdrawal quote | 10, 10 + 1 | 6, 6 + 1 |
| Deposit build, withdrawal build | 3 each | 1 each |
