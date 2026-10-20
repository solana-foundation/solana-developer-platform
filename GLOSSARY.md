# Solana Developer Platform

The product language SDP's code, API and docs share.

## Recurring payments

**Schedule**:
An agreement to move a fixed amount from a source wallet to a destination every period, which SDP activates,
updates, cancels, resumes and collects on.
_Avoid_: recurring payment row, subscription (the on-chain mandate)

**Attempt**:
One claimed run of an activation, update, cancel or resume on a schedule.
_Avoid_: job, operation

**Step**:
One on-chain transaction inside an attempt.
_Avoid_: send, phase

**Effect**:
The on-chain account state whose presence proves a step landed.
_Avoid_: result, outcome

### Step states

**Unsent**:
A step with no saved signature; it was never broadcast.

**Landed**:
A step whose effect is on chain.

**Dropped**:
A step whose saved send can never land: its effect is absent and the chain is past the transaction's expiry.
_Avoid_: expired (a schedule status), failed

**Pending**:
A step whose saved send may still land, or whose state could not be read.
_Avoid_: unknown, landing, in flight
