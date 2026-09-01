# 0003. Veda vault withdrawals — the exit path for `vault_direct`

Date: 2026-08-19
Status: Partially implemented (2026-08-21). The context below predates
PRO-1702, which landed `POST /v1/earn/vault-withdrawals`, its service and the
Kamino exit — so "there is no route at all" is HISTORY, not the present.
Decision 3 ("instant lands first, and alone") is implemented: `@sdp/veda`
builds the instant redemption through that route, with a quote-derived
`minAmountOut` floor (`supportsVaultWithdrawQuote` /
`POST /v1/earn/vault-withdrawal-previews`). Decisions 1 (the queued
capability), 4 (the request table) and 6 (the closed-request indexer) remain
open on the product answer to open question 5.

## Context

SDP can now move money INTO a non-custodial vault and not back out. That is
true for both `vault_direct` providers and for different reasons:

- **Kamino** withholds `buildVaultWithdrawal` because its exit plan is not
  correctly batched — a multi-reserve exit can exceed Solana's 1232-byte packet
  and the builder returns one unsized batch (`packages/sdp-kamino/CLAUDE.md`).
- **Veda** can build a correct single-transaction exit today. What is missing is
  everything on SDP's side: **there is no `POST /v1/earn/vault-withdrawals`
  route at all**, and no service behind it.

`VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` is `["sandbox"]` precisely because of this
gap. Nothing is fund-trapped — the shares sit in the organization's own custody
wallet and each provider's own surfaces can redeem them — but SDP's product is
one-directional until this lands.

Veda is also the first provider whose exit is not one shape. It offers two,
independently, and the SDK deliberately refuses to choose between them:

> "Instant and queued withdrawals are reported independently because both may be
> available for the same vault. The SDK does not automatically choose a
> withdrawal route." — `@vedatech/svm-sdk` README

## What Veda actually offers

Read from `@vedatech/svm-sdk@0.1.0-alpha.1` and the `boring_vault_svm` /
`boring_onchain_queue` IDLs committed in `packages/sdp-veda/idl/`.

### Instant redemption

`buildWithdraw({ asset, shares, protection })` burns shares and pays the asset
out in ONE transaction. Available only when the vault's
`teller.withdraw_authority` is the unset pubkey — the SDK's
`resolveWithdrawalOptions` makes exactly that comparison, and a named authority
means someone else must sign, so the holder cannot leave on their own schedule.

Shape-wise this is a deposit in reverse: one atomic transaction, an amount
floor the SDK refuses to default (`minAmountOut`), and an outcome fully
determined by whether the transaction lands.

### Queued withdrawal

Three separate on-chain steps with three separate actors:

1. The holder calls `request_withdraw` (`buildRequestWithdrawal`), which escrows
   shares and creates a `WithdrawRequest` PDA carrying `shares`, quoted
   `assets`, a `discountBps`, a `maturityTimestamp` and a `deadlineTimestamp`.
2. **A solver Veda operates** — the queue's `solve_authority` — calls
   `fulfill_withdraw` some time after maturity. SDP is not that actor and cannot
   make it happen.
3. If the deadline passes unfulfilled, the holder calls `cancel_withdraw`
   (`buildCancelWithdrawal`) to take the shares back.

Fulfilment and cancellation both CLOSE the request account. The SDK reports
status as `pending | fulfillable | expiredCancelable | closedOrUnknown`, and is
explicit that distinguishing "fulfilled" from "cancelled" after the fact
"requires transaction indexing outside the SDK".

### Share locks

`config.lock_duration_seconds` locks shares for a period after each deposit;
`getUserPosition` reports the resulting `unlockTimestamp`. A non-zero lock
delays every exit regardless of which route is used, which is why the catalogue
already reports such a vault as `liquidityTerm: "delayed"` with a day count.

## Why a document first

Three of the decisions below cannot be made by whoever writes the code, because
they are not code decisions:

1. **Which routes SDP exposes at launch** is a product question, and the answer
   changes the schema (see "Open questions", 5).
2. **The queued lifecycle does not fit the movement model**, so it needs a
   schema addition — and under the deploy ordering in the pluggability playbook,
   a schema addition is EXPAND-ONLY in the release that adds it. Getting that
   wrong stalls the catalogue writer for as long as the previous image is live.
3. **Opening `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` to production is a global
   switch** that would open Kamino at the same time — and Kamino still has no
   exit path. That decision must be made deliberately, by a human, and it is
   NOT part of this work.

## Decision

### 1. Two capabilities, not one

Instant redemption is the existing `EarnVaultWithdrawProvider` capability:
`buildVaultWithdrawal` returns an `EarnVaultTransactionPlan`, discovered by
`supportsVaultWithdraw`. Veda becomes the first provider to answer true.

Queued withdrawal gets a NEW optional capability rather than being folded in.
The reason is the same one that split money-out from money-in in the first
place: `buildVaultWithdrawal` promises "one plan, and when it lands the money
has moved". A queue request that lands has moved no money — it has created an
obligation that a third party settles later. Folding them together would make
`supportsVaultWithdraw` assert something it cannot deliver.

Proposed shape, mirroring the existing capability style (method-presence guard
in `packages/sdp-earn/src/capabilities.ts`, never an id check):

```ts
interface EarnVaultQueuedWithdrawProvider extends EarnVaultDirectProvider {
  getWithdrawalOptions(ctx, input): Promise<EarnVaultWithdrawalOptions>;
  buildQueuedWithdrawalRequest(ctx, input): Promise<EarnVaultTransactionPlan>;
  buildQueuedWithdrawalCancel(ctx, input): Promise<EarnVaultTransactionPlan>;
  readQueuedWithdrawalRequests(ctx, input): Promise<EarnVaultWithdrawalRequest[]>;
}
```

### 2. Never auto-select a route

`getWithdrawalOptions()` is surfaced to the caller — instant available, queued
available, and the reason when neither is. SDP picks neither. The two have
materially different outcomes for a holder (immediate settlement at the current
share price, versus a discounted quote settled by someone else on their
schedule), and choosing on their behalf would be SDP making a pricing decision
it was not asked to make. The SDK's refusal to choose is the right default and
this inherits it.

### 3. Instant lands first, and alone

The instant path needs NO schema change. `earn_vault_movements` already carries
`direction IN ('deposit','withdraw')` (migration `0059`), and its lifecycle —
build → simulate → sign → durably record → broadcast → confirm — describes an
instant redemption exactly as well as it describes a deposit. The reconcile
cron (`cron/earn-vault-movements.ts`) needs no new states.

So the first implementation PR is: `buildVaultWithdrawal` in `@sdp/veda`, a
`vault-withdrawal.service.ts` mirroring `vault-deposit.service.ts`, and
`POST /v1/earn/vault-withdrawals`. That is a complete, shippable exit for any
vault whose redemption is permissionless.

### 4. Queued withdrawals need a new TABLE, not a new column

A queue request is a long-lived object with terminal states that are not
observable from the transaction that created it. Its creating transaction is
`confirmed` within seconds; the request itself stays pending for hours or days
and is settled by an actor SDP does not control.

Putting that on `earn_vault_movements` forces one of two bad outcomes: either
`confirmed` means two different things depending on `direction`, or the movement
stays nonterminal for the request's whole life — and the sweep's work queue
(`idx_earn_vault_movements_unsettled`) never drains.

Proposed: a new `earn_vault_withdrawal_requests` table, keyed on the request
PDA, holding the on-chain identity (address, nonce, asset mint), the quote as
requested (shares, assets, discount bps, maturity and deadline timestamps), a
lifecycle status, and FKs to the movement that CREATED it and the movement that
CANCELLED it. A new table is also the cleanest EXPAND: the previous release's
writers never touch it at all, so the deploy ordering hazard the playbook
describes — migrations run before the service rolls, and a rollback restores the
old image over the new schema — cannot bite.

If any column is added to an EXISTING table as part of this work, it is nullable
in the release that adds it and `SET NOT NULL` comes in a later one.

### 5. Money out never inherits a money-in gate

ADR 0002's exit-safety invariant, restated because this is the path it exists
for. Every withdrawal route gates on:

- **`assertEarnProviderConfigured`** — the provider's credentials, which for
  Veda is vacuous (it is keyless) but stays in the call for uniformity.
- **Custody-wallet authorization** — the caller may act for the wallet holding
  the shares, with a WRITE-scoped binding, exactly as the deposit route requires.

And on NOTHING else. Specifically **not** `assertEarnProviderSurfaced`, **not**
the organization entitlement override, **not** `assertStrategyDepositable`, and
**not** `isVaultDirectDepositEnabled`. A strategy that is `paused`, a provider
that has been un-surfaced, an organization whose override was revoked — every
one of those must still be able to get its money out. Route tests should pin
each of these individually, the way `earn-program.test.ts` pins the equivalents
for the custodial path.

### 6. Reconciliation for a request nobody at SDP settles

Instant withdrawals reconcile through the existing movement sweep, unchanged.

For queued requests, the honest problem is that `closedOrUnknown` is genuinely
ambiguous: the account is gone, and the SDK cannot say whether it was fulfilled
or cancelled. Two options, and the recommendation is the second:

- **Record `closed_or_unknown` and stop.** Truthful and cheap, but it leaves a
  customer's ledger permanently unable to say whether they were paid.
- **Index the closing transaction.** `getSignaturesForAddress(requestAddress)`
  finds the transaction that closed the account, and `parseLifecycleEvents`
  (exported by the SDK) decodes `withdrawalFulfilled` / `withdrawalCancelled`
  from its logs — including `assetsPaid`. That is one extra RPC pair per closed
  request, on a pass that only runs for requests already known to be closed.

Take the second, and keep `closed_or_unknown` as the state a request rests in
when the closing transaction cannot be read — never as a guess.

### 7. Withdrawal assets resolve exactly like deposit assets

`buildWithdraw` takes an asset, so the same resolution the deposit builder uses
applies: the vault's own enabled assets, screened by `isVedaDepositMint`, with
ambiguity REFUSED rather than resolved. And `minAmountOut` is required for the
same reason it is required on deposit — Veda's SDK refuses an implicit slippage
tolerance and SDP does not invent one.

## Sequencing

| PR | Contents | Gate to start |
|---|---|---|
| 1 | This document | — |
| 2 | `buildVaultWithdrawal` in `@sdp/veda`, withdrawal service, `POST /v1/earn/vault-withdrawals`, `GET .../:movementId` | Veda confirms deployment addresses (`VEDA_DEPLOYMENTS` is empty; nothing can be proven until then) and confirms the launch vault's `withdraw_authority` |
| 3 | `GET /v1/earn/vault-positions/:id/withdrawal-options` | after 2 |
| 4 | Queued capability, `earn_vault_withdrawal_requests` migration, request/cancel routes, the closed-request indexer | product answer to open question 5 |
| — | `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` including `"production"` | **escalated, not part of this work** — the constant is global and flipping it opens Kamino, which still has no exit path |

## Open questions

Escalate these; do not answer them by reading code.

1. **Does the launch vault expose instant redemption?** i.e. is
   `teller.withdraw_authority` the unset pubkey? If it is not, PR 2 has no
   effect for that vault and the queue becomes the launch path — which reorders
   everything below it.
2. **Who operates the solver, and what is the fulfilment expectation?** The
   queue's `solve_authority` is Veda's. SDP would be showing customers a
   pending obligation it cannot advance, so the SLA is a support commitment
   before it is an engineering one.
3. **What discount and deadline bounds does the launch vault's
   `WithdrawAssetData` enforce** (`minimumDiscountBps`, `maximumDiscountBps`,
   `secondsToMaturity`, `minimumSecondsToDeadline`, `minimumShares`)? These are
   caller inputs on `buildRequestWithdrawal` with no safe defaults, so the UI
   has to read them rather than guess.
4. **Is a share lock configured?** A non-zero `lock_duration_seconds` means a
   withdrawal route must surface `unlockTimestamp` and refuse before it, rather
   than letting the program reject the transaction.
5. **Which exits does SDP expose at launch — instant, queued, or both?** This is
   the product decision PR 4 waits on, and it is also open question 5 of the
   original integration plan.

## Consequences

- Veda becomes the first provider where `supportsVaultWithdraw` is true, which
  makes the capability guard load-bearing for the first time: the withdrawal
  route must narrow on it and refuse Kamino, in the same deployment, on the same
  contract.
- The dashboard's vault positions can stop labelling their withdrawal action
  unavailable for Veda while continuing to for Kamino — a per-provider answer
  the UI does not currently have to make, and which must come from the API
  rather than from a client-side provider list.
- Nothing here changes what a customer can already do outside SDP. Withholding
  a route has never been a permission gate, and none of these steps may become
  one.
