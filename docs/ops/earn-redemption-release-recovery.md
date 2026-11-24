# Recover a finalized Hastra release

Use this operator tool when a current-redemption release stays `settling`
because its provider event evidence is missing or cannot be decoded. The
operator must independently verify the exact accepted cancellation and retain
that evidence in an internal review or incident ticket.

The command requires the stored operation, build, attempt and signature to
match. It fetches that signature's finalized successful receipt, takes a fresh
worker claim, then commits the review evidence, completion, address cooldown
and audit entry together. It performs one transaction read and sends no
transaction. A replay of an already completed recovery reads only storage.

## Verify the release

1. Match organization, project, environment, operation, build and attempt against
   the stored accepted release. Inspect the exact signed cancellation, including
   its owner, provider and request address.
2. Verify that its own signature finalized successfully and the transaction
   released the current redemption. Record the evidence URL, ticket and reason.
   A closed request account alone cannot establish that this release ran.
3. Use the approved environment's operator credentials. Normal worker leases and
   retry scheduling still apply; a leased or not-yet-due operation is refused.
   Wait for its next recovery window instead of changing lease rows.

## Run the audited recovery

```bash
pnpm --filter @sdp/api earn:redemption-release:recover \
  --organization-id <organization-id> \
  --project-id <project-id> \
  --environment <sandbox-or-production> \
  --operation-id <operation-id> \
  --transaction-id <canonical-build-id> \
  --attempt-id <accepted-attempt-id> \
  --signature <accepted-signature> \
  --operator <operator-identity> \
  --reason <review-reason> \
  --ticket <incident-or-review-ticket> \
  --evidence <https-evidence-url> \
  --attestation verified_current_redemption_release
```

The API image bundles the same entry as `recover-redemption-release.js`.
The explicit attestation means the operator verified the release, rather than
inferring it from expiry, a missing account or another cancellation.

Success reports `completed`; `replayed: true` means the matching recovery was
already complete. An audit failure rolls back completion and the address
cooldown. Repeating the same identifiers is safe.

## Check the result

Read the operation and its audit record. The release result is `recovered` with
`settledAmount: null`; it establishes no PRIME return or USDC payout. Earlier
covered withdrawal activity ends with `REDEMPTION_SUPERSEDED` and leaves active
polling. Its historical financial fields stay unchanged. That bookkeeping
result does not establish nonexecution or permit an automatic retry of the
original withdrawal.
