# SDP data retention and deletion

HOO-2303 owns this policy. The 30-day periods below are proposed for review.
`ACCOUNT_PII_RETENTION_ENFORCED` stays `false` until the retention owner approves
them in a reviewed change. `prune-account-pii` runs hourly at minute 37 and
reports candidate counts in dry-run mode. Existing Clerk-triggered account
deletion does not depend on that age-based enforcement gate.

## Retention table

| Data                                                        | Retention                                                                                                        | End of retention                                                                                 | Access                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Account name and email (`users`)                            | Until no live linked identity remains                                                                            | Clear name; replace email with a stable, non-deliverable pseudonym; mark deleted                 | Person, organization directory, platform workloads |
| Identity email (`auth_user_identities`)                     | Until final account deletion; retired identities keep their address for invitation cleanup                       | Clear email; retain opaque provider linkage and deletion record                                  | Authentication and platform workloads              |
| Clerk deletion tombstones (`clerk_deleted_users`)           | Indefinite                                                                                                       | Retain opaque provider id to reject delayed identity mapping and profile events                  | Platform workloads only                            |
| Invitation email                                            | Proposed: 30 days after latest creation, expiry or acceptance; deletion only matches stored user/identity emails | Pseudonymize email; expire stale pending invitations; preserve invitation ids and roles          | Organization members and platform workloads        |
| Notification actor/subject snapshots and delivery email     | Proposed: 30 days after creation                                                                                 | Clear actor/subject strings and replace recipient email; preserve send/dedupe evidence           | Platform workloads                                 |
| Request idempotency snapshots, including batch external ids | Existing: 24 hours                                                                                               | Existing hourly job prunes expired request keys                                                  | Authenticated project and platform workloads       |
| Durable batch external ids and money-movement rows          | Indefinite                                                                                                       | Preserve business dedupe, signed intent, settlement, and recovery evidence                       | Authorized project readers and platform workloads  |
| Payment-request payer address and settlement evidence       | Indefinite                                                                                                       | Preserve settlement verification and recovery; no name or email is required                      | Authorized project readers and platform workloads  |
| Transfer memo in SDP                                        | Indefinite with the financial record                                                                             | Retain movement evidence; never put account PII in free text                                     | Authorized project readers and platform workloads  |
| Published on-chain data                                     | Chain lifetime                                                                                                   | SDP cannot erase published transactions or memos                                                 | Public                                             |
| Pending/failed ramp webhook payload                         | Until explicitly resolved                                                                                        | Never age out unresolved settlement evidence                                                     | Replay worker and operators                        |
| Discharged ramp webhook payload/outcome                     | Existing: body cleared at discharge; outcome retained seven days                                                 | Existing replay job archives the outcome and clears provider event id/error                      | Replay worker and operators                        |
| Audit rows, hashes, anchors, and opaque actor ids           | Existing: indefinite                                                                                             | Never mutate or delete sealed rows; scrub metadata before sealing                                | Authorized organization readers and operators      |
| Audit IP and user agent                                     | Existing: indefinite within sealed rows; new anonymous-payer entries retain only a network and no user agent     | Keep prior sealed context immutable; anonymous-payer IPv4 /24 and IPv6 /48 networks are retained | Authorized organization readers and operators      |
| Cloud Logging, Sentry, backups, and external email delivery | Set by each service's owner                                                                                      | Separate provider retention/restore controls; not changed by the database job                    | IAM/project membership                             |

An idempotency key's expiry never authorizes deleting a financial recovery row
or forgetting a batch's durable business dedupe key.

Legacy `sessions` and `magic_links` were removed by migration 0131 and hold no
current data.

## Account deletion

The existing implementation from [PR #2833](https://github.com/solana-foundation/solana-developer-platform/pull/2833)
records a lasting `clerk_deleted_users` tombstone. After the last linked identity
is deleted, it clears the user's name and identity emails and replaces the
user's email with a pseudonym. Invitation cleanup only matches addresses still
stored in `users` or `auth_user_identities`, including retired identities. The
membership mirror first revokes pending invitations it finds at those
addresses; final deletion pseudonymizes matching non-pending invitations.
Opaque user ids remain stable for history. This retention change reuses that
implementation.

An email change from X to Y can remove the last stored link to X. Invitations to
X can then retain their email and pending status after final account deletion.
[HOO-2758](https://linear.app/solana-fndn/issue/HOO-2758)
tracks the historical-address fix. Age-based cleanup is disabled, so the
proposed 30-day period does not currently scrub those copies.

Notification snapshots follow the proposed age-based policy above. Shared
business counterparties, provider-held verification records, arbitrary customer
free text, copied legacy Private Channels principal names, on-chain data, and
immutable audit entries need their own ownership and recovery rules. Do not
claim global erasure from a successful account-deletion webhook.

## Operation and rollout

Apply migrations 0222–0225 before the worker revision. They add one nullable
invitation marker and concurrent indexes; the previous image can still read the
schema. The existing 0221 deletion migration belongs to PR #2833.

Every sweep emits `sdp_account_pii_pruned` with its mode, per-table counts, and
batch-cap status. No row values are logged. Dry-run counts stop at 20,000
candidates per table; `capped` means more may remain. Enforcement uses batches of 1,000 rows, at most 20 batches per run, with
`FOR UPDATE SKIP LOCKED`. Partial indexes exclude already-scrubbed history;
repeats and overlapping workers are safe. Invitation eligibility uses the
latest creation, expiry, or acceptance, including legacy UTC timestamp formats.
A failed batch rolls back and escapes to the standard `sdp_cron_run` error signal.
Verify delivery of that alert and an hourly liveness check before enforcement.

Approval of the 30-day periods and enabling enforcement are separate from
shipping the retention worker. Production data, external provider retention, and
Cloud Logging/Sentry settings are not modified by this change.

## Design references

The Data Classification section of each design links to this proposed policy:

- [SDP-001: Login and membership](https://app.notion.com/p/3ebd36dad52d8063ad39fefeae4a97af)
- [SDP-021: Batch transfers](https://app.notion.com/p/3f2d36dad52d803bbfc4d005bf4568a8)
- [SDP-022: Payment requests](https://app.notion.com/p/3f2d36dad52d80dbb83fd30af00bbb0e)
- [SDP-024: Single transfers](https://app.notion.com/p/3f2d36dad52d80259948d52d24eb9cfb)

HOO-2372 tracks the other design-document gaps. PR #2833 covers HOO-2345
anonymous-payer audit-context minimization.

See [PII scrubbing](pii-scrubbing-policy.md),
[audit-ledger retention](../ops/audit-ledger.md#retention-and-recovery), and
[idempotency keys](../decisions/0009-idempotency-keys.md).
