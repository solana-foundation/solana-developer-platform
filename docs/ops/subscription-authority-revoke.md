# Subscription authority revoke

HOO-2339 adds an operator-only revoke of the token approval a custody wallet
gives the Subscriptions program (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`)
for one token. Every recurring payment from that wallet in that token shares
one delegate on the wallet's token account: the program's per-mint
subscription authority. SDP keeps its allowance at 0 between collections
and approves each collection's own amount in that collection's transaction,
and the authority account stays open until revoked. Use this during an
incident to revoke and close it now, so no schedule on it can collect until it
is activated again: a suspected program or upgrade-authority compromise, a wallet still
carrying an unlimited approval from before HOO-2339, or a collection pulling
more than its plan.

The SDP on-call owns it. Record the human operator, the reason and the
incident or Linear ticket; the command logs them with the outcome as
`sdp_subscription_authority_operator_revoke`.

## What it does

- Revokes the SPL delegate and closes the authority account, refunding its
  rent, in one transaction the wallet signs and the sponsor pays for.
- It is the `recurring.revoke_authority` exit, signed with no money principal
  like the hourly sweep: an organization's suspension and a disabled movement
  (HOO-2334) never refuse it.
- It ignores what still uses the approval. Every live recurring payment on that
  wallet and token, in any project, can no longer collect: the output lists them
  under `brokenRecurringPayments`, each with its `projectId`. Their collections fail on chain and pause them
  after the failed-attempt limit (HOO-2340). Cancel them, or once the incident
  is over, activate replacements; resuming a paused one does not re-approve.
- An activation or update already running on the wallet when it is claimed
  never recreates the authority or subscribes to one: it answers `409` before
  sending either, and leaves its schedule to be activated again later.
- Only a revoke already in flight for the same authority stops it (`held`).
  Run the command again after that one settles, or check the authority on
  chain.

The everyday paths are unchanged: a recurring payment's cancel revokes the
approval when it was the last one using it, and the hourly
`revoke-subscription-authorities` sweep revokes the rest once idle.

## Run it

The command runs in `apps/sdp-api`, with the same environment as the target
API deployment (its database and custody secrets). Check the organization,
project and wallet ids before running it.

```sh
pnpm --filter @sdp/api recurring:revoke-authority \
  --organization-id ORG_ID --project-id PROJECT_ID \
  --custody-wallet-id CUSTODY_WALLET_ID --token TOKEN_MINT \
  --operator ops:NAME --reason 'INCIDENT_REASON' --ticket HOO-NNNN
```

It prints the outcome, the authority address and the schedules it broke, and
exits non-zero unless the outcome is `revoked`:
- `revoked`: the authority is gone from the chain.
- `pending`: the send's outcome is unknown; the sweep settles it on its next
  run. Check the authority with `solana account <address>` meanwhile.
- `failed`: nothing it sent can land; the error is on the revocation row
  (`payment_subscription_authority_revocations`). Fix the cause and rerun.
- `held`: another revoke of the authority is in flight.

To stop every token on a wallet, run it once per token.

Drill it once on stage, on a wallet with two live recurring payments in one
token, and record the evidence in HOO-2339: the revoke lands, both schedules
are listed, their next collections fail and pause, and what a cancel of one of
them then returns.
