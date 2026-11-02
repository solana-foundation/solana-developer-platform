# Plume Earn execution

Plume is a `vault_direct` RWA provider for Treasury Solutions and Embedded Yield.
The catalogue lives in `@sdp/earn`; this package owns Solana transaction admission,
position reads, account preparation, standard and instant redemption, cancellation,
and provider delivery observation. Neither package needs a Plume API key.

## Deployment and rollout

The pinned deployment registry is `@sdp/types/plume-programs`. It contains the
published mainnet nOPAL deployment. nBND must be added only after Plume supplies its
slug, share mint, OFT store/escrow, composers, relayer, lookup table and decimals.
There is no invented devnet deployment. Production-only vaults use the existing
sandbox mirror behavior. Plume surfacing and money-in remain disabled until live
validation; Earn's public publication hold remains unchanged.

The API must already have its normal mainnet RPC, custody and optional sponsorship
configuration. Plume's Predicate v2 attestation checks happen in the mint builder;
a 403 is a wallet eligibility refusal, not an API-key setup request. Live testing
requires a Plume-approved wallet, USDC and network fees, through an authorized
staging/canary workflow. Do not use a laptop to exercise production APIs.

## Flows

- A sponsored first mint first finalizes a separate idempotent share ATA setup.
  An existing live share account returns `not_required` without signing or fees.
  Treasury does this automatically. Embedded apps use the provider action build,
  sign, submit and read endpoints before building a deposit.
- Mint uses the provider's VersionedTransaction unchanged. Its keeper and ephemeral
  CCTP signatures are verified and preserved. Neither its blockhash, payer nor
  instructions can be rewritten; fund USDC separately instead of composing a swap.
- Standard redemption is an asynchronous request. Instant redemption uses the
  available instant liquidity path but still crosses chains. Neither is an atomic
  payout and neither requires a later user-signed claim transaction.
- Standard cancellation sends an update to zero using the original recorded
  composer. Plume updates the aggregate pending request for that wallet/vault,
  so cancelling may affect multiple requests. Only an exact full share return can
  close the selected SDP movement automatically; partial or aggregated returns
  stay open for recovery. Already-delivered USDC is not recalled.
- Source finality leaves the economic obligation open. Provider status supplies a
  candidate destination signature; SDP independently reads that finalized Solana
  transaction, verifies the bridge program/accounts and the exact owner/mint token
  credit, and records a unique receipt. Indexing 404s remain pending. Provider
  errors, missing history and unavailable RPC never become fabricated completion.

## Admission and operational limits

All amounts use exact mint-scale integers. Mint and instant API requests are
bounded by JavaScript's safe integer range because those API fields are numeric;
standard requests use decimal integer strings. OFT dust is rejected. Plume cannot
enforce SDP output floors across chains, so minimum output fields are refused.
SDP admits CCTP fees up to 1% of input and OFT native fees up to 0.1 SOL. These are
local admission ceilings, not provider fee quotes. Unexpected instruction layouts
fail closed and require investigation before changing the pinned admission rules.

No SDK initializes a raw signer, RPC endpoint or sponsor. Execution uses the
project cluster scope and the shared custody/sponsorship waists. New provider
commands claim a durable row before building or signing. Uncertain sends retry
only the original signed bytes. Cancellation receipts record zero USDC payout and
reopen the share position.

## RPC budget

Before this provider: no Plume calls. Each live position/build proof uses one
`getMultipleAccounts` batch (five accounts cold; three with mint identities cached
for five minutes). Concurrent identical proofs share that batch; balances are
never cached between operations. Transaction admission uses one latest-blockhash
read plus one validity read, and at most one pinned lookup-table read per minute.
The shared simulation consumes these admitted lookup tables without reading them
again for pre-signed mints. A destination receipt costs one finalized transaction
read only when provider status supplies a candidate signature. Failed static reads
are never cached.

## Source references

- [Plume Solana integration](https://app.plume.org/docs/developers/integration-guides/nopal#solana-integration)
- [Circle pinned CCTP v2 IDL](https://raw.githubusercontent.com/circlefin/solana-cctp-contracts/ec16e95d28ee47f7832df4203ae07b5981d146fc/examples/target/idl/token_messenger_minter_v2.json)
- [LayerZero OFT 3.0.159 serializer](https://app.unpkg.com/@layerzerolabs/oft-v2-solana-sdk@3.0.159/files/src/generated/oft302/instructions/send.ts)

The Core API reference names standard builds `/solana/nest/async-redeem/build-tx`;
the integration guide also contains `/async-redeem/request/build-tx`. This
implementation uses the Core API route. Verify that route, current ABI fixtures,
fee/rent behavior, keeper signatures and status payloads during live validation
before enabling the provider. No silent route fallback or transaction rewriting.
