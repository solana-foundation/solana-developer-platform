# Hastra PRIME engineering inventory

Hastra is the Solana wrapper/operator layer; Figure supplies the underlying
YLDS and Democratized Prime HELOC exposure. SDP fronts exactly one strategy:
PRIME funded with mainnet USDC through wYLDS. The provider is registered but
remains deliberately unsurfaced until its production release review and live
end-to-end checks are complete. SDP's default USDC exit is Hastra's at-par
operator redemption. The market-liquidity exit through Jupiter is retained as
an explicit deployment opt-in, not a fallback SDP selects for the caller.

This inventory follows Hastra's public Solana integration guide and the exact
[`v0.0.6` source revision](https://github.com/provenance-io/hastra-sol-vault/tree/121e4cc600b976a97faa018359e00bda48113ec2).
Where prose and program differ, the pinned program source is authoritative.
Mutable operator and security-review claims were last checked 2026-09-22.

## Pinned mainnet deployment

| Role | Address |
| --- | --- |
| `vault-mint` program (USDC ↔ wYLDS) | `9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV` |
| `vault-stake` PRIME program (wYLDS ↔ PRIME) | `97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY` |
| wYLDS mint | `8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih` |
| PRIME mint / SDP provider reference | `3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7` |

All three tokens use six decimals. Hastra publishes no deployment that SDP has
verified on devnet, so execution is mainnet-only. The programs are upgradeable;
an address match alone is not a permanent code-identity guarantee. The adapter
therefore revalidates program ownership, config PDAs, mints, vaults, authorities,
decimals, pause state, account initialization, and the Chainlink price state on
each quote/build.

## Money movement

| Route | Finality means | Detailed movement |
| --- | --- | --- |
| Deposit | Atomic receipt of PRIME | One SDP-built transaction transfers USDC to the `vault-mint` deposit vault and mints the same raw amount of wYLDS; it then transfers that wYLDS to the PRIME stake vault and mints PRIME at the live Chainlink rate. There is no direct one-instruction USDC→PRIME method, but the composed route is one Solana transaction. |
| Optional DEX exit | Atomic receipt of at least the caller's USDC floor | When `EARN_HASTRA_DEX_EXIT_ENABLED` is truthy and `JUPITER_SWAP_API_KEY` is configured, one transaction burns PRIME, transfers wYLDS from the stake vault to the owner, then executes an admitted Jupiter ExactIn wYLDS→USDC route. Any failed native or swap instruction rolls the whole transaction back. This route is disabled by default. |
| Default par request | A request exists, **not** a USDC payout | One transaction burns PRIME for wYLDS and calls `vault-mint.request_redeem`. That call creates one owner-derived request PDA and delegates the requested wYLDS amount to Hastra's redeem authority. The wYLDS is not burned or escrowed at request time. |
| Par completion | Operator-delivered USDC | A Hastra rewards administrator calls `complete_redeem(expected_amount)`. The program burns the delegated wYLDS, transfers the same raw amount of USDC from the separately funded redemption vault to the owner's USDC account, and closes the request PDA. |
| Par cancellation | Request released; owner keeps wYLDS | The owner calls `cancel_redeem`. The program revokes its delegate when that delegate is still present, closes the request, and refunds its rent to the owner. Cancellation does not mint PRIME back. If Hastra has frozen the wYLDS account while its delegate is present, SPL Token can reject that revocation until the account is thawed. |

The at-par path is asynchronous because the USDC payout comes from a separate
operator-funded redemption vault. Hastra's guide describes off-chain YLDS
conversion and Circle CCTP funding, which can be delayed by batching and banking
hours. It is not a Veda-style solver queue: there is no on-chain maturity,
deadline, discount, bidding, or solver fill.

`EARN_HASTRA_DEX_EXIT_ENABLED` is fail-closed and false when unset. It controls
only the admission and advertisement of new Jupiter withdrawal quotes/builds;
it does not disable USDC→wYLDS→PRIME deposits, position reads, par requests,
par cancellation, or par reconciliation. Hastra provider availability is
therefore keyless. Turning the flag off also does not rewrite the settlement
meaning of a previously admitted DEX withdrawal: its recorded transaction
remains an atomic movement and the durable movement reconciler continues to
confirm, rebroadcast, or expire it without rebuilding it.

Two details in the public guide are stale for `v0.0.6`: it says
`request_redeem` burns wYLDS, and its example calls `complete_redeem()` with no
argument. The program actually grants a burn allowance at request time and
requires `complete_redeem(expected_amount)` so an administrator's approval
cannot be replayed against a cancelled-and-recreated request for another
amount. The burn happens only in the completion transaction. It also means the
owner can move the wYLDS or replace/revoke the delegate while a request is
open. Doing so leaves the PDA pending but makes completion fail until the full
requested balance and Hastra delegate are restored or the owner cancels.

## Permission boundaries

"Permissionless" here means no allowlist, KYC signature, or provider API key
is checked by that user instruction. It does not mean immutable, unstoppable,
or independent of Hastra operations.

| Action | Who signs | Permission / operational dependencies |
| --- | --- | --- |
| USDC→wYLDS `deposit` | Token owner | Permissionless user call; fails if `vault-mint` is paused, accounts are frozen/mismatched, or funds are insufficient. |
| wYLDS→PRIME `deposit` | Token owner | Permissionless user call; also requires an initialized, positive, non-stale administrator-refreshed Chainlink price. |
| PRIME→wYLDS `redeem` | Token owner | Permissionless and immediate in `v0.0.6`; requires the stake program unpaused, a live price, unfrozen accounts, and enough wYLDS in the stake vault. The old unbond instruction is gone. |
| wYLDS→USDC DEX swap | Token owner | Optional open-market Jupiter route; requires `EARN_HASTRA_DEX_EXIT_ENABLED`, `JUPITER_SWAP_API_KEY`, routable liquidity, and a quote/build service. It does not use Hastra's redemption administrator. |
| `request_redeem` | Token owner | Permissionless creation, subject to `vault-mint` pause/freeze/balance checks and the one-open-request rule. |
| `cancel_redeem` | Request owner | Permissionless for that owner and intentionally allowed while paused. It can still fail if the wYLDS account is frozen and the Hastra delegate must be revoked. |
| `complete_redeem` | Hastra rewards administrator | **Not permissionless.** Requires exact request amount, sufficient delegated wYLDS, sufficient operator-vault USDC, and an authorized admin signature. Completion itself is not pause-gated. |
| Price/reward publication, freeze/thaw, upgrades | Hastra-configured administrators / upgrade authority | Privileged. These controls can change availability, token mobility, the rate, or program code. |

This explains the asymmetric USDC flow: minting accepts fresh USDC and can
issue wYLDS deterministically 1:1 on-chain. Redeeming depends on Hastra first
making USDC available after the off-chain reserve/unwind/bridge process, so the
user can request or cancel but only an administrator can settle from that
redemption vault.

## Fees, floors, and minimums

| Item | What is actually enforced |
| --- | --- |
| Hastra 50 bps | Hastra describes this as an **annual platform fee deducted from PRIME's earned rate**: `PRIME rate = HELOC+ utilization rate − 0.50%`. It is not a 50 bps deposit, swap, unstake, or redemption charge, and it is not 50 bps of the yield payment. |
| YLDS "SOFR − 50 bps" | A separate underlying YLDS rate convention. Do not combine it with, or substitute it for, PRIME's Hastra platform fee. |
| Native program transaction fees | The `v0.0.6` deposit, stake, redeem, request, cancel, and completion processors contain no explicit fee or haircut. `vault-mint` moves equal raw USDC/wYLDS amounts; stake conversion uses the oracle rate and floors integer division. |
| Optional DEX exit | When enabled, market price impact, spread, and any route fees are reflected in the Jupiter quote. SDP requires an encoded final-USDC floor. Its 50 bps default tolerance is a caller-adjustable **slippage bound**, not a fee or promised execution cost. |
| Solana costs | The payer owes network/priority fees and, where absent, ATA rent. A par requester must also fund the request PDA's rent; Hastra hardcodes the owner as payer and terminal rent recipient. |
| Deposit minimum | `vault-mint` accepts any positive `u64` amount (one USDC atom), but `vault-stake` must mint at least one PRIME atom. The effective minimum is therefore the smallest USDC amount whose wYLDS converts to one PRIME atom at the live rate. |
| PRIME redeem minimum | The PRIME amount must convert to at least one wYLDS atom at the live rate. SDP calculates this dynamic minimum rather than hardcoding a token quantity. |
| Par-redemption minimum | The program itself accepts one wYLDS atom (`0.000001`) and therefore enough PRIME to produce that atom. Hastra separately documents a current **$2,000 batching minimum** for operator/CCTP processing. It is not encoded in `v0.0.6`; SDP must not pretend it is an on-chain per-request check or promise when a sub-$2,000 request will be fulfilled. Confirm Hastra's current operator policy before production launch. |
| Open requests | Exactly one redemption-request PDA per owner. Completion or cancellation closes it, after which the same deterministic address can be reused. |

Neither native deposit instruction supports a caller-encoded `minSharesOut`.
SDP refuses such a parameter instead of advertising protection the programs do
not enforce. The optional DEX route does support and require `minAmountOut` on
final USDC. Hastra's current fee article repeats the annual 0.50% model, but also
contains an editorial `[VERIFY]` marker in a later paragraph; commercial terms
still need written confirmation before SDP's production launch.

## Timing, account, and integration gotchas

- PRIME→wYLDS is no longer queued or bonded. It settles in the redeem
  transaction, subject to Solana finality and the live program checks above.
- The default par path has no on-chain SLA. Hastra warns about CCTP/banking-hours
  delay and recommends stopping at wYLDS when USDC settlement is unnecessary.
  The optional DEX path has market-liquidity and quote-expiry risk but no Hastra
  operator wait.
- Deposits create the owner's wYLDS and PRIME associated token accounts when
  missing. Exits create the needed wYLDS/USDC accounts. A sponsor may pay those
  ATA rents on ordinary routes; a par request's program-created PDA must be paid
  by the owner and always refunds the owner.
- The request PDA does not record a token-account address, only owner, mint, and
  amount. SDP uses the canonical owner wYLDS ATA consistently so the operator
  can find the delegated balance.
- The owner-derived request PDA has no per-cycle nonce. SDP bounds each durable
  lifecycle search at that cycle's creation signature, but that read-side
  boundary cannot change what a still-valid transaction authorizes on-chain:
  a prior signed cancellation can target a quickly recreated PDA, and a prior
  operator completion can target a recreated request when its expected amount
  is identical. The adapter therefore proves the PDA absent at confirmed and
  finalized state, locates its latest successful close from authenticated
  vault-mint lifecycle logs (ignoring arbitrary and failed address mentions),
  and refuses reuse until more than 200 finalized block heights after that
  close. The operator must use ordinary recent blockhashes rather than durable
  nonces for completion; durable-nonce transactions would defeat any finite
  reuse cooldown.
- Both composed exits fix the wYLDS amount when the transaction is built, while
  `vault-stake.redeem` recomputes actual wYLDS at execution. SDP redeems into a
  fresh seeded classic-token account, moves exactly the snapshotted amount to
  the canonical owner ATA, and immediately closes the fresh account before the
  Jupiter swap or par request. A lower live output fails the fixed transfer; a
  higher output fails the close. The transaction rolls back in either case and
  must be rebuilt at the new rate. Pre-existing or concurrently received wYLDS
  in the canonical ATA remains outside this equality check and is not included
  in the fixed swap or delegation amount.
- Hastra can freeze wYLDS and PRIME token accounts. A frozen balance still
  belongs to the wallet but cannot be transferred or burned until thawed.
- The price is `wYLDS per PRIME × price_scale`. Both stake directions floor
  integer division. A zero/uninitialized or stale Chainlink observation stops
  deposits and PRIME redemptions, including both exit paths.
- A legacy v1 unbonding ticket may still exist for an owner. `redeem` accepts it
  as an optional account, closes it, and refunds its rent to the owner; callers
  without one pass the program ID as Anchor's `None` sentinel.
- When the optional lane is enabled, Jupiter instructions are admitted through
  SDP's existing ExactIn boundary: pinned owner/mints/input, bounded slippage,
  approved programs, no foreign signer, and a 20-account route limit. The lane
  requires both `EARN_HASTRA_DEX_EXIT_ENABLED` and the shared
  `JUPITER_SWAP_API_KEY`. Base Hastra availability does not depend on that key:
  its native deposit and default par-redemption instructions need no provider
  credential.

## Security-review status

In this context, STRIDE most likely means
[Solana Trust, Resilience and Infrastructure for DeFi Enterprises](https://stride.asymmetric.re/),
the Asymmetric Research / Solana Foundation program covering program security,
governance, oracles, infrastructure, supply chain, operations, monitoring, and
logging. It is not merely the similarly named Microsoft threat-model mnemonic.

No primary source found in Hastra's site, the public `hastra-sol-vault`
repository, or STRIDE's public material names Hastra as having completed or
passed a STRIDE assessment. STRIDE's first-findings report is aggregate and
does not identify assessed protocols. Status is therefore **not publicly
verified**, not "failed". Hastra's public source does provide reproducible-build
machinery, CodeQL, Squads upgrade configuration, a security contact, and a
Figure vulnerability-disclosure-policy link; those are useful controls but are
not evidence of STRIDE completion.

## Primary references

- [Hastra Solana programmatic integration guide](https://help.hastra.io/integration-guides/hastra-sol-programmatic-integration-guide)
- [`hastra-sol-vault` v0.0.6 source](https://github.com/provenance-io/hastra-sol-vault/tree/121e4cc600b976a97faa018359e00bda48113ec2)
- [Hastra explanation of the PRIME rate and annual 0.50% fee](https://help.hastra.io/537c06bd5c2e82d398e0014be2ff02b2)
- [STRIDE framework](https://stride.asymmetric.re/) and its [aggregate first findings](https://stride.asymmetric.re/first-findings)
