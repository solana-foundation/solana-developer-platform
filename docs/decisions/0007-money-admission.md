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
   gets a signer or sponsor that refuses with 403 `FORBIDDEN`, logged as
   `sdp_money_refused`, and an exit always signs for the organization (see the 2026-10-15 addendum for the credential). The decision is `decideMovement`, a pure function of the
   `projects ⋈ organizations` row, read alongside rows the waist already reads.
   Refusing at signing, not at resolution, keeps confirm-only flows working.
4. **CI pins what could bypass the waists**: the constructors that turn a
   stored secret into a signing adapter, keypair or fee payer
   (`scripts/check-value-movement.mjs`, TypeScript checker, shrink-only
   allowlists). It scans the API and every package the API loads; the
   packages that define the constructors (`sdp-custody`, the fee-payment
   module) own them. A file it allows can still wrap a pinned constructor in
   a new function, so those files are trusted and reviewed like the waists.

## Consequences

- Classifying a movement as `exit` exempts it from the organization's
  admission, so it is a security-reviewed change, as is adding a file to a
  checker allowlist.
- Exits that let the caller pick a destination (Private Channels and Rings
  withdrawals) are accepted as they are for the organization. The only
  organization that reaches them through the API has lost the production
  entitlement and still owns the funds; a compromised organization is
  suspended, and a suspended organization's requests are refused before any
  handler runs. The credential is decided for them like any exit (addendum).
- A revoked organization's same-key retry of a completed request gets the
  refusal, not its stored response: authentication refuses the organization
  before idempotency replays anything (HOO-1918, #2251). There is no special
  case.
- Production entitlement is decided for starts only. The edge's own
  production checks (#2228) still refuse some exits for a production project
  without the entitlement; opening those routes at the edge is follow-up work,
  and until then such an exit is refused at the edge, never at a waist.
- Provider-API money (provider-managed payouts and withdrawals) does not pass
  a signer; a future provider-API start needs its own waist.
- Asynchronous, quorum-based signing (pending approvals, not built yet) must
  call the same decision when it opens a signing request and again when it
  executes, so a revocation during the wait still holds.

## Addendum — 2026-10-15 The credential decides exits too (HOO-2099)

API keys gained a wallet scope that only the waists enforce, so "an exit
always signs" would let a key scoped to one wallet withdraw another wallet's
Private Channels or Rings balance to any address. The waists now decide every
signature from the ambient principal (`lib/money-principal.ts`), exits
included:

- **The organization still never refuses an exit.** A suspended or unentitled
  organization can always unwind; nothing above changes for it.
- **The credential does.** A key must be live and may sign only with a wallet
  in its scope; a member must be live; a mandate signs only with its own
  source wallet. An exit needs no action: the route's action admitted it.
- **No principal, no read.** A reconciler or job finishing a payout runs with
  no principal, and its exit signs without a database read, as before.
- Routes that record a movement or call a gateway before they sign (Private
  Channels, Rings) make the same scope refusal up front, from the
  authenticated request, so a refused withdrawal leaves nothing behind.
  So do the Idempotency-Key routes that name a source wallet (transfers,
  transfer batches, signer check), in `authorize`: there the refusal also
  keeps a failed row and its key out of the store, so a retry after the
  scope is fixed runs. `assertCallerWalletInScope` reads the scope from
  authentication (ADR 0009) and is a fast refusal only; the waist still
  decides every signature.
- **Recurring payments scope every write (HOO-2337, SDP-023 RE-3).** A
  pending schedule's edit signs nothing, but the activator later signs the
  terms it left, so a key scoped to wallet A could set what an in-scope
  activator of wallet B signs. The recurring routes' `authorize` therefore
  refuses an API key whose scope lacks the schedule's source wallet (or the
  wallet an update moves it to) on create, every update shape, cancel,
  activate, collect and resume, signing or not. Reads and lists stay
  project-wide. A dashboard session holds every wallet; the job and
  revocation cancel run without a request and are unchanged.
- **A claim the job can finish is ordered against revocation.** A fresh
  recurring activation or resume is admitted before its claim, and the claim
  re-reads the activating key under a share lock (`lockLiveActivatingKey`).
  Revocation locks the key row and lists what it started after it commits,
  so revoke-and-cancel either refuses the claim or sees it.

## Alternatives considered

- **Capability token carried to the signer** (draft #2250): rejected, above.
- **Deactivating custody rows on deletion only**: blocks exits and covers only
  deletion, not entitlement.
- **Hand-kept route lists or source-text tests**: drift silently (HOO-1990).

## Proposed exception: Fireblocks native transfers (PR #2455)

**Status: proposed; requires named security-owner approval before merge.** This
section does not change the accepted signing rule above and is not evidence of
security sign-off. The new `fireblocks-native-transfer` allowlist entry in
`scripts/check-value-movement.mjs` needs the same explicit approval.

Fireblocks BYOK uses native `TRANSFER` for SOL and USDC. SDP checks the initiating
principal's live status, grants, wallet scope, organization, project entitlement
and connection before creating the transfer. Fireblocks then owns construction,
approval, signing, fee payment and broadcast. SDP has no execution callback at
which to re-run `decideMovement` immediately before Fireblocks signs.

The proposed boundary treats an accepted Fireblocks request as an externally
committed payment: later SDP key revocation, membership removal, organization
suspension, entitlement changes or connection deactivation prevent new SDP
submissions but do not revoke that already accepted instruction. An unknown POST
outcome may also have been accepted and must be treated the same way. Customers
must reject or cancel pending transfers in Fireblocks when revoking access to
contain an incident. A cancellation request can race signing or broadcasting and
cannot guarantee that funds remain in the source vault.

Compensating controls are tenant-scoped server-held API credentials, an Editor
API user, Fireblocks-managed approval rules and designated signers, a durable
external transaction ID with no automatic resubmission, exact settlement-intent
checks, beta gating, and audit logs. These controls do not close the revocation
race. SDP does not claim that its API user's RSA authentication key approves or
signs blockchain transfers, and does not change Fireblocks policies for users.

Alternatives: disable native transfers; use a provider signing flow with a
supported enforceable execution callback; or add best-effort cancellation on SDP
revocation as an additional mitigation. Cancellation alone does not satisfy the
accepted atomic pre-sign admission requirement.

Approval record (must be completed by the security owner): reviewer name,
review date, PR/comment link, accepted exposure, and approval of both this
exception and the `fireblocks-native-transfer` allowlist entry.
