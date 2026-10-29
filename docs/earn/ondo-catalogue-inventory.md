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
depend on finding this file. The jurisdiction rules are Ondo's, from its
[USDY eligibility page](https://docs.ondo.finance/general-access-products/usdy/eligibility),
fetched 2026-10-15. Ondo's page governs: re-check it before relying on these
lists. The row names the US and Canada and links the page for the rest.

- **Prohibited jurisdictions.** Individuals located or residing in, and
  entities organized under the laws of or with a principal place of business
  in, any of these are Ondo "Prohibited Persons", barred from "subscribing for,
  acquiring or redeeming USDY tokens": Afghanistan; Belarus; Canada; Crimea,
  the Donetsk and Luhansk People's Republics, the Kherson and Zaporizhzhia
  regions and the city of Sevastopol (Ukraine); Cuba; North Korea (listed by
  Ondo as "Democratic Republic of Korea"); Iran; Libya; Myanmar; Russia;
  Somalia; South Sudan; Sudan; Syria; and the United States, including its
  states, possessions, territories and federal districts. An entity 50% or more
  owned or controlled, in aggregate, by Prohibited Persons may be barred too.
- **US persons and US orders.** Also barred: buy orders placed from within the
  US, and "US persons" under Rule 902 of Regulation S or anyone acting for
  their account or benefit.
- **Qualified or professional investors only.** Individuals residing in (in
  some cases, citizens of) and entities organized or based in Brazil, the EEA,
  Hong Kong, Malaysia, Singapore, Switzerland and the UK must meet that
  jurisdiction's investor category (Ondo's page maps each) "in order to be
  issued USDY tokens". The page's intro applies these restrictions to
  "subscribing for, acquiring or redeeming"; the row takes that stricter
  reading.
- **Partner clause.** "By agreeing to a business relationship with Ondo, any
  partners agree to not offer Ondo related products or services in connection
  with any of the outlined prohibited jurisdictions."
- **Not enforced on-chain or by SDP.** Any wallet can buy and hold USDY on the
  secondary market, so the party offering the strategy to end users screens
  them. SDP performs no eligibility check of its own.
- **Issuer freeze authority.** Ondo holds both the mint and the freeze authority
  on the USDY mint, so any token account, including an SDP custody wallet's,
  can be frozen by the issuer. A frozen account cannot exit through the
  secondary market until unfrozen.
- **Primary mint/redeem is unused.** SDP buys and sells USDY on the secondary
  market, so positions taken through SDP are never subject to any
  primary-facility term (PRO-1834 tracks the primary facility as a large-size
  backstop). Ondo's docs, fetched 2026-10-15, state no lockup duration for it.
  They say "onboarding is necessary for minting or redeeming"
  ([comparison to stablecoins](https://docs.ondo.finance/general-access-products/usdy/comparison-stablecoins)),
  describe the on-chain `USDY_InstantManager` as minting and redeeming
  "instantly", within rate limits and minimums
  ([integration guide](https://docs.ondo.finance/developer-guides/usdy-instant-manager-integration)),
  and list that contract on Ethereum, BNB Chain and Tempo, with only the token
  on Solana ([addresses](https://docs.ondo.finance/addresses)). The Ethereum
  `USDYc` ("Cooking USDY") row there covers "the period before their USDY
  tokens are issued" but gives no duration. The 40 to 50 day figure SDP used to
  cite came from Ondo's since-retired USDY FAQ page "Investing & Redeeming": a
  "Restricted Period", usually 40 to 50 days from deposit, before tokens were
  issued, with early redemption only above $100,000
  ([last archived 2026-03-01](https://web.archive.org/web/20260301113727/https://docs.ondo.finance/general-access-products/usdy/faq/investing-and-redeeming);
  the live page now returns 404). Treat any primary-facility timing as
  unconfirmed until Ondo states it directly.

## Where it shows and where it executes

- **Production catalogue**: the row, `fundable: true`, once the deployment's
  production pass can read mainnet.
- **Sandbox catalogue**: the PRO-1742 browse-only mirror, `fundable: false`, on
  the explicit `?cluster=mainnet-beta` opt-in. Ondo has no devnet deployment
  (verified on-chain 2026-09-02; Ondo's staging also runs on mainnet).
- **Deposits**: production projects only, derived from `ONDO_DEPLOYMENTS`
  having no devnet entry (`EARN_PROVIDER_DEPLOYED_CLUSTERS.ondo`). Mainnet is
  wallet-pays: the custody wallet needs SOL for fees and for its USDY token
  account's rent, and USDC to swap.
- **Platform prerequisites**: `JUPITER_SWAP_API_KEY` (shared with swap-funded
  deposits) in the deployment, and a mainnet RPC the catalogue can reach.
  Ondo's availability gates on the Jupiter key, so without it the provider
  reports `configured: false` and no deposit action is offered. Every
  deployment reaches mainnet through its mainnet managed RPC pool
  (`SOLANA_RPC_<PROVIDER>_MAINNET_API_KEY_URL`, handed to the catalogue as
  `ctx.catalogueRpcUrl`); without one the production pass skips and the
  sandbox mirror stays empty. The rate and TVL need nothing
  extra: Ondo's assets API is public.
- **Per-org**: `providerOverrides.earn.ondo` in the organization's Clerk
  private metadata, synced by the `organization.updated` webhook.
