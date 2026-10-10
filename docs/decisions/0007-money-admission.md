# 0007: Money admission is enforced where SDP signs

- Status: accepted
- Issue: HOO-1955 (with Apex APE-387, APE-358, APE-564)

## Context

An organization that is deleted or suspended, or a production project whose
organization lost the production entitlement, must not start new money
movement. Money it already committed must still be able to come out: the same
exit-safety rule ADR 0002 set for Earn, applied here to every module.

Before this decision, the check lived only where requests enter. Background
jobs and `/pay` had no authenticated actor at all (closed by #2245), and the
API-key edge trusted a cached organization status, so a failed cache refresh
left a revoked key working on every route (APE-387). A first design minted an
"admitted movement" capability token and required it at the signers; review
found it forgeable, found that an exit's token unlocked a general signer, and
found the CI check pinned function names rather than capabilities. It was
dropped.

## Decision

1. **Authentication reads organization and key status fresh** on every
   request, on the uncached organization read it already makes. This lands in
   its own PR (APE-387); caches then only make rejection cheaper.
2. **Jobs and `/pay` admit before the first new signature**
   (`lib/money-admission.ts`). Work that only confirms an earlier signature
   never asks. A refused recurring collection skips the period.
3. **The two signing waists decide again, from live rows, when asked to sign.**
   Every custody signature comes from
   `CustodyRuntimeTargets#getTransactionSignerForWalletRecord`, and every
   tenant sponsor signature from `createSponsorshipFeePayment`. There is no unscoped sponsor:
   every sponsor has a tenant and a movement. Each caller names its
   movement (`MOVEMENTS` in `@sdp/types`); a start the organization may not make
   gets a signer or sponsor that refuses (`sdp_money_refused`, 403), and an
   exit always signs. The decision is `decideMovement`, a pure function of the
   `projects ⋈ organizations` row, read alongside rows the waist already reads.
   Refusing at signing, not at resolution, keeps confirm-only flows working.
4. **CI pins what could bypass the waists**: the constructors that turn a
   stored secret into a signing adapter, keypair or fee payer
   (`scripts/check-value-movement.mjs`, TypeScript checker, shrink-only
   allowlists).

## Consequences

- Classifying a movement as `exit` exempts it from admission, so it is a
  security-reviewed change, as is adding a file to a checker allowlist.
- Exits that let the caller pick a destination (Private Channels and Rings
  withdrawals) are accepted as they are. The only organization that reaches
  them through the API has lost the production entitlement and still owns the
  funds; a compromised organization is suspended, and a suspended
  organization's requests are refused before any handler runs.
- A revoked organization's same-key retry of a completed request gets the
  refusal, not its stored response (ADR 0008, idempotency, #2251). There is no special case.
- Production entitlement is decided for starts only; the edge's own
  production checks (#2228) still refuse some exits, which PR C reopens.
- Provider-API money (BVNK payouts, provider-managed withdrawals) does not pass
  a signer; a future provider-API start needs its own waist.
- Asynchronous, quorum-based signing (pending approvals, not built yet) must
  call the same decision when it opens a signing request and again when it
  executes, so a revocation during the wait still holds.

## Alternatives considered

- **Capability token carried to the signer** (draft #2250): rejected, above.
- **Deactivating custody rows on deletion only**: blocks exits and covers only
  deletion, not entitlement.
- **Hand-kept route lists or source-text tests**: drift silently (HOO-1990).
