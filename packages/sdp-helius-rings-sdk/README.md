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

This package is the only place Kit 7 lives. Verified rather than assumed:

```
packages/sdp-helius-rings-sdk  @solana/kit 7.1.1   (shared with zolana and its @solana-program peers)
apps/sdp-api                   @solana/kit 6.8.0
```

The boundary is the main barrel, which exports `createRingsGateway` plus the plain-DTO
`validateOuterTransaction` policy boundary. The gateway takes plain strings and returns a
`RingsGatewayPort` whose types all come from the Kit-free `@sdp/helius-rings`; the validator also exposes
no Kit-branded values. The client, authority and material types remain reachable only from inside this
package. That is a hard rule rather than a convention, because the failure it prevents is not a compile
error: two majors' branded `Address` types can match structurally, so a leaked type would typecheck and
then behave as the wrong major's value at runtime.

The `./testing` subpath sits outside that rule: it is Kit-neutral by design and exists to be imported
from Kit 6. The deterministic key authority remains internal; `@sdp/api` passes its seed to
`createRingsGateway` as a string rather than constructing a material source itself.

Bytes still cross, since the port carries an encoded transaction. `apps/sdp-api` asserts from its own Kit 6
that a transaction this package encoded under Kit 7 decodes and re-encodes byte-identically
(`services/helius-rings/kit-cross-major.test.ts`), using the `./testing` subpath as the Kit 7 producer.

## Where key material comes from

An identity's Solana owner and its shielded keys come from different places, and that split is the
reason this package looks the way it does.

The owner is an SDP custody wallet. Its Ed25519 secret stays in custody, signs the outer Solana
transaction, and is never readable here. The shielded keys come from a `ShieldedMaterialSource`
(`material.ts`). Its callback scope destroys the source-owned key objects on exit, reducing accidental
retention; callback code can still copy key material, so the process remains trusted. Whatever the source,
`assertShieldedIdentity` re-derives the persisted identity on every use and fails closed rather than
silently addressing a different one.

**The source is meant to be replaced, so it is quarantined.** The only one that exists today is
`deterministic-ka`. V1 derives viewing and nullifier material from a permanent 32-byte platform-held seed
and the exact organization/project/random `hrw_*` row-id path, then binds it separately to the custody
owner's public key. That stability is necessary to re-derive an existing identity, but it is not a
fund-recovery design. The source is interim because the platform can derive every tenant's private
material; replacing it changes only the `ShieldedMaterialSource` behind the port.

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

Spend authorization is not in-circuit: ownership enters the proof as public-key material, while the
Solana runtime requires the owner's Ed25519 signature on the outer transaction. The split keeps that
secret in custody, but it does not make an in-process compromise harmless; compromised code can copy
shielded keys and bypass this package's in-process checks before invoking custody. The signature remains
required, but this design does not prove that a compromised process cannot obtain one.

`requestUserApproval` is a defense-in-depth owner check only for high-level builders that call it. The
enabled low-level transfer and withdrawal paths do not. They instead validate the readable prepared
intent before encryption and proving, then validate the final unsigned wire before custody signing.
Those controls catch accidental or upstream intent drift; they are not a security boundary against a
compromised process.
