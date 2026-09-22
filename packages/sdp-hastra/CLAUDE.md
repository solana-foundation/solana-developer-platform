# @sdp/hastra

Execution adapter for Hastra PRIME on Solana. The catalogue half lives in
`@sdp/earn`; this package owns live state validation, raw v0.0.6 Anchor
instructions, positions, and both exit paths. The API exposes the
operator-completed par redemption by default; the Jupiter DEX builder remains
available only when the deployment opts in.

## Pinned deployment

Use only `@sdp/types/hastra-programs`. Its program IDs and token mints are tied
to Hastra release v0.0.6 / source commit
`121e4cc600b976a97faa018359e00bda48113ec2`. Do not copy addresses into API
code or discover arbitrary Hastra pools.

Every build reads and validates the live program/config/mint/vault identities,
account discriminators, PDA bumps, token authorities, and six-decimal scales.
Hastra's programs are upgradeable, so a pinned program address alone is not a
sufficient execution boundary.

## Money movement

- Deposit is one transaction: USDC -> wYLDS (`vault-mint.deposit`) -> PRIME
  (`vault-stake.deposit`). v0.0.6 has no encoded minimum-share argument, so the
  builder refuses `minSharesOut` instead of claiming a fictional floor.
- The optional DEX withdrawal is one transaction: PRIME -> wYLDS
  (`vault-stake.redeem`) -> USDC (an API-admitted Jupiter ExactIn leg). It
  requires `minAmountOut` and proves Jupiter's encoded threshold covers it.
  The API advertises and builds it only when `EARN_HASTRA_DEX_EXIT_ENABLED` is
  truthy and `JUPITER_SWAP_API_KEY` is configured; the flag is off by default.
- Default par redemption is a separate capability: PRIME -> wYLDS followed by
  `vault-mint.request_redeem`. Hastra delegates, rather than burns, wYLDS at
  request time. An operator later burns it and pays USDC. There is no
  cancellation deadline and cancellation remains allowed while paused, but an
  SPL freeze can block the delegate revocation it needs. Only one request PDA
  exists per owner.

The often-cited $2,000 figure is an off-chain operator/CCTP batching threshold,
not a v0.0.6 per-request program constraint. Execution therefore exposes the
program's actual minimum: enough PRIME to produce one wYLDS atom. Hastra's 50
bps fee is an annual deduction from PRIME's earned rate, not a native-program
transaction fee; the separate 50 bps DEX tolerance is only a slippage bound.

## Important constraints

- Jupiter instructions enter only through `HastraSwapPort`, implemented by the
  API's reviewed Jupiter admission boundary. Never add a Jupiter HTTP client
  here. This package deliberately retains the builder regardless of rollout
  state; the API owns the default-off capability gate so deposits, position
  reads, and par-redemption operations remain available without a Jupiter key.
- Disabling the optional DEX lane stops new quotes and builds. It must not stop
  submission or reconciliation of an already admitted transaction: those
  durable movements remain atomic, and recovery must continue from their
  recorded signed bytes rather than rebuilding them.
- The PRIME/wYLDS rate comes from the validated `StakePriceConfig`;
  `vault-mint` is exact 1:1 while both `vault-stake` conversion directions
  floor integer division. Both composed exits fix their later wYLDS amount at
  build time while PRIME redemption recalculates output at execution.
  Each builder redeems into a fresh seeded classic-token account, transfers the
  exact snapshotted amount into the canonical wYLDS ATA, then closes the fresh
  account. A lower live output fails the transfer and a higher one fails the
  close, so neither direction can consume or strand unrelated canonical funds.
  See `docs/earn/hastra-prime-inventory.md`.
- `RedemptionRequest` has no cycle nonce. Before reusing its owner-derived PDA,
  prove it absent at both confirmed and finalized state, find the latest
  successful close through an authenticated vault-mint lifecycle event, and
  wait more than 200 finalized block heights so every ordinary
  recent-blockhash action from the prior cycle is expired. Ignore arbitrary or
  failed mentions of the PDA. Operator completions must not use durable nonces.
- `request_redeem` hardcodes the owner as request-account rent payer and rent
  recipient. Par requests must refuse a different `rentPayer`.
- Cancellation is deliberately not pause- or oracle-gated. It releases an
  obligation and Hastra's program permits it while paused, but it can still
  fail when the wYLDS account is frozen and its delegate must be revoked.
- Lifecycle decoding accepts `Program data:` only while the pinned vault-mint
  program is the active invocation frame, derives the request PDA from the
  event owner, checks both mints, and uses finalized transaction `blockTime`.
- SDP supports only Hastra's verified mainnet token/config deployment.
  `sponsoredPrograms("devnet")` must remain empty until an explicit devnet
  deployment is verified and admitted.

## Verification

```sh
pnpm --filter @sdp/hastra typecheck
pnpm --filter @sdp/hastra test
pnpm --filter @sdp/hastra lint
```
