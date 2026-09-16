# Ondo catalogue inventory

Ondo's shelf is one instrument, not a census: USDY, the yield-bearing US
Treasury token, read from the mint address Ondo publishes and SDP pins in
`ONDO_DEPLOYMENTS` (`@sdp/types/ondo-programs`). There is no vault program. A
deposit is a Jupiter-routed USDC→USDY swap signed by the owner, the position is
the owner's USDY balance, and the exit is the reverse swap. Surfaced 2026-09-14
(PRO-1832); registered dormant 2026-09-02 (PRO-1803).

## The row

| Field | Value | Where it comes from |
| --- | --- | --- |
| `providerReference` / `shareMint` | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` | The USDY mint, verified on-chain each pass (SPL token, 6 decimals) |
| `hostCluster` | `mainnet-beta` | Measured by genesis hash before the mint is read |
| `sourceKind` | `rwa` | Tokenized note backed by short-term Treasuries and bank deposits; traces to the issuer's published mint, the same allowlist bar Veda clears |
| `depositMints` | mainnet USDC only | The pair Ondo's own market-making liquidity quotes; other stablecoins ride the swap-funded deposit leg into USDC first |
| `liquidityTerm` | `instant` | Secondary-market exit, no lock |
| `currentApy` | issuer-published APY as a fraction (e.g. `0.035999` for Sep 2026's 3.5999%, shown as 3.6%) | `ondo.finance/api/v1/assets`, the `usdy` entry's `apy`, read keylessly each hourly pass and truncated, never rounded up (PRO-1833) |
| `riskMetadata.tvlUsd` | USDY supply on Solana in USD | Same listing, `tvlUsd.solana` |
| `depositSlippage` / `withdrawalSlippage` | 50 bps default, quote required | Both legs are real swaps; the builder proves the encoded threshold covers the caller's floor |
| `riskMetadata.curator` | `ondo` | Issuer attribution |

## Eligibility and issuer controls

Recorded here and on the row (`riskMetadata.eligibility`,
`riskMetadata.issuerControls`) so an integrator's compliance review does not
depend on finding this file.

- **Reg S, non-US persons only.** USDY is offered under Regulation S. The
  restriction is NOT enforced on-chain: any wallet can hold the token, so the
  party offering the strategy to end users screens them. SDP performs no
  eligibility check of its own.
- **Issuer freeze authority.** Ondo holds both the mint and the freeze authority
  on the USDY mint, so any token account, including an SDP custody wallet's,
  can be frozen by the issuer. A frozen account cannot exit through the
  secondary market until unfrozen.
- **Primary mint/redeem is unused.** Freshly minted USDY carries a 40 to 50 day
  Reg S transfer lockup and sub-$100k primary redemptions wait out that
  window, which is why SDP trades the secondary market instead (PRO-1834 tracks
  the primary facility as a large-size backstop). Positions taken through SDP
  are therefore never subject to that lockup.

## Where it shows and where it executes

- **Production catalogue**: the row, `fundable: true`, once the deployment's
  production pass can read mainnet.
- **Sandbox catalogue**: the PRO-1742 browse-only mirror, `fundable: false`, on
  the explicit `?cluster=mainnet-beta` opt-in. Ondo has no devnet deployment
  (verified on-chain 2026-09-02; Ondo's staging also runs on mainnet).
- **Deposits**: production projects only
  (`EARN_PROVIDER_VAULT_DIRECT_DEPOSIT_ENVIRONMENTS.ondo`). Mainnet is
  wallet-pays: the custody wallet needs SOL for fees and for its USDY token
  account's rent, and USDC to swap.
- **Platform prerequisites**: `JUPITER_SWAP_API_KEY` (shared with swap-funded
  deposits) in the deployment, and a mainnet RPC the catalogue can reach.
  Ondo's availability gates on the Jupiter key, so without it the provider
  reports `configured: false` and no deposit action is offered. A devnet
  deployment reaches mainnet through `SOLANA_MAINNET_RPC_URL`
  (`resolveCatalogueRpcUrl` in `@sdp/earn`); without it the production pass
  skips and the sandbox mirror stays empty. The rate and TVL need nothing
  extra: Ondo's assets API is public.
- **Per-org**: `providerOverrides.earn.ondo` in the organization's Clerk
  private metadata, synced by the `organization.updated` webhook.
