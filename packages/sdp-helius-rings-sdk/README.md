# @sdp/helius-rings-sdk

Adapter over the Helius Rings ([zolana](https://github.com/helius-labs/zolana)) TypeScript SDK. SDP owns
operation state, policy, approvals, custody signing and fee sponsorship; this package owns everything
that touches zolana wire formats and Rings key material.

`@sdp/helius-rings` is the domain layer — types, the state machine, and the gateway port. This package is
the adapter behind that port.

## Why it is its own package

`@heliuslabs/zolana` requires `@solana/kit` 7. The workspace catalogue is on Kit 6.8.0, `sdp-api`
included, and Kamino's klend-sdk drags in Kit 2.3.0. Four majors already coexist because pnpm's isolated
layout keeps each subtree on its own resolution — so the fix is a boundary, not an upgrade.

This package is the only place Kit 7 lives. Its public surface takes and returns plain strings, so the
major does not leak into a consumer still on Kit 6, where the two `Address` brands would not be
assignable to each other. Verified rather than assumed:

```
packages/sdp-helius-rings-sdk  @solana/kit 7.1.1   (shared with zolana and its @solana-program peers)
apps/sdp-api                   @solana/kit 6.8.0
```

## Where key material comes from

An identity's Solana owner and its shielded keys come from different places, and that split is the
reason this package looks the way it does.

The owner is an SDP custody wallet. Its Ed25519 secret stays in custody, signs the outer Solana
transaction, and is never readable here. The shielded keys come from a `ShieldedMaterialSource`
(`material.ts`), which hands material to a callback and destroys it when the callback ends, so no
implementation can leave live secrets behind. Whatever the source, `assertShieldedIdentity` re-derives the
persisted identity on every use and fails closed rather than silently addressing a different one.

**The source is meant to be replaced, so it is quarantined.** The only one that exists today is
`deterministic-ka`, which recomputes material from one master seed with HKDF and stores nothing at rest.
What makes it interim is that the platform holds that seed and can therefore derive every tenant's viewing
and nullifier keys — not that the derivation is deterministic. It lives behind its own entry point,
`@sdp/helius-rings-sdk/deterministic-ka`, and the main barrel never re-exports it, so replacing it means
adding another `ShieldedMaterialSource` and deleting one directory. Nothing downstream of the interface
moves.

A real key authority still has to put both secrets in this process, which is a constraint of the SDK
rather than a shortcut: `WalletAuthority` returns concrete `ViewingKey` and `NullifierKey` instances, and
`ViewingKeyLike` states that a backend answering viewing-key operations over a wire is unsupported. So the
seam is where material comes from, not who holds it.

**This is why the SDK's own types could not be reused.** Every `ShieldedKeypair` constructor —
`generate`, `fromKeypair`, `withViewingKey` — expands the nullifier key from a signing secret, and
`LocalWalletAuthority` takes a `ShieldedKeypair`. There is no constructor for "independent viewing key,
independent nullifier key, external Ed25519 owner", so `CustodyWalletAuthority` implements
`WalletAuthority` directly. `ShieldedAddress.fromPublicKeys` publishes the three public halves together,
which is the shape the on-chain user record stores.

The split works because spend authorization is not in-circuit. Ownership enters the proof as
`ownerProofInputHash()`, which is public key material, and authorization is the owner's Ed25519
signature on the outer Solana transaction, enforced by the Solana runtime. `WalletAuthority` has no
signing method at all, so this package holds exactly one of the two gates: a fully compromised process
means total privacy loss and zero fund movement. The Rust sidecar reached the same conclusion by a
different route — see [`apps/sdp-helius-gateway`](../../apps/sdp-helius-gateway/README.md) → "The
security model checks out at compile time".

`requestUserApproval` verifies rather than prompts. SDP resolves policy and approval before any builder
runs, so the check that matters is that the builder is spending under the owner that approval covered;
a mismatch is `RingsApprovalMismatchError`, not a dialog.

## Running it

```bash
pnpm --filter @sdp/helius-rings-sdk test        # vitest, no network
pnpm --filter @sdp/helius-rings-sdk typecheck
pnpm exec biome check packages/sdp-helius-rings-sdk
```

The devnet gate moves real funds and never runs in CI. It reads a gitignored `.env.local`:

```
HELIUS_RINGS_DEVNET_E2E=1
HELIUS_RINGS_RPC_URL=https://devnet.helius-rpc.com/?api-key=…
HELIUS_RINGS_INDEXER_URL=http://zolnet-devnet-1779374825.eu-north-1.elb.amazonaws.com
HELIUS_RINGS_PROVER_URL=http://zolnet-devnet-1779374825.eu-north-1.elb.amazonaws.com:3001
HELIUS_RINGS_ALLOW_INSECURE_HTTP=1
HELIUS_RINGS_E2E_SEED=<32 bytes, base64>
HELIUS_RINGS_E2E_SPL_MINT=<optional classic-SPL mint the owner holds>
```

```bash
cd packages/sdp-helius-rings-sdk
set -a && . ./.env.local && set +a
pnpm exec vitest run --config vitest.devnet.config.ts --reporter=verbose
```

Both Rings endpoints are plain http, which is why `HELIUS_RINGS_ALLOW_INSECURE_HTTP` exists: in
plaintext the indexer response reveals which notes an identity owns and the prover request carries the
witness, so the transport carries the protocol's privacy and enabling it is a per-environment decision.

Owners are HKDF-derived from the same seed, so repeated runs reuse funded accounts instead of stranding
lamports. Each needs about 0.2 SOL. The Helius devnet faucet is IP rate-limited to roughly one airdrop
at a time — fund owner 0 and transfer to owner 1. The gate asserts the genesis hash is devnet's before
it signs anything.
