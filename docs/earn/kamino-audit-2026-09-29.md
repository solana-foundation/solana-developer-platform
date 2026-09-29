# Kamino vault flow audit, 2026-09-29

**Disposition: the confirmed integration defects are fixed locally.** This is a
Critical fund-movement change awaiting independent review, internal security
review, applicable CI and staging validation. It is not a zero-loss guarantee.

## Scope and provenance

- Branch `codex/kamino-audit`, isolated from fetched `origin/main` at
  `f31813d81d8b0a1cfcf40886cd2ba67e100d8fce`.
- Reviewed catalogue/quotes, amount conversion, SDK plans, share consolidation,
  provider binding, custody and external-wallet builds/submits, signature checks,
  persistence, reconciliation, sponsorship/rent, position values and dashboard
  amount/slippage flows.
- Registry-pinned `@kamino-finance/klend-sdk@10.0.0`; dependencies unchanged.
  Foundation SDLC verified at `09daad42233a0df63180d52447c52de41692e577`.
- No production database, real signing key, real funds, deployment, push or
  release. Chain execution used local Surfpool forks and generated wallets
  funded with synthetic SOL and tokens.

## Fixed findings

### P1: requested deposits were reported as actual deposits

The provider encodes a maximum deposit and can accept less when capacity
changes. The ledger previously copied `amount_requested` into settlement
amounts. A request for 10 that deposited 3 could report 10 and misstate earnings.

The new finalized receipt reader identifies exactly one recognized Kamino
deposit, checks its signature, cluster programs, owner signature, vault, mints,
encoded maximum and share floor, then counts its token-transfer and mint CPIs
using integer arithmetic. It ignores a preceding swap's credit. Metadata with
unknown layouts, inconsistent decimals or mismatched identities returns no
amount. Token and Token-2022 debit instructions are covered.

Requested amounts remain intact. Actual debit and minted shares are recorded
only with receipt provenance. Missing receipts do not block finality: amounts
remain unknown and a bounded, retry-spaced job repairs them later. Historical
rows have no age cutoff. Movement reads, earnings and the unified transaction
view ignore legacy guesses. `totalDeposited` contains only observed amounts;
`earned` is withheld with `deposits_not_valued` while relevant deposits remain
unvalued. Exposure admission can conservatively retain the requested maximum.

Migration 0119 is additive. It adds provenance and a repair index without
rewriting old rows, allowing the previous revision to remain schema-compatible.
Repair updates historical amounts only when finalized chain evidence exists.
Tests exercise the actual migration with old rows, old-revision projections,
scoped repair, replay, overspend rejection and new-reader behavior.

### P2: concurrent builds could refund rent to the wrong payer

Two deposit builds can both observe a missing share ATA. Its idempotent create
charges only the first transaction, while the old projection selected the
newest non-failed creation claim as the refund recipient.

The old behavior was reproduced on a local devnet fork: payer A funded
2,039,280 lamports, payer B funded zero, and a full exit refunded B all
2,039,280 lamports. The affected funds were account rent, not vault principal.

Kamino now ignores historical refund claims and strips the SDK's unconditional
share-ATA close. Share ATAs remain owner-controlled, including after a full
exit; the rent is recoverable through an explicit owner-authorized close. This
intentionally defers automatic sponsor reimbursement instead of guessing it.
The API no longer projects new Kamino creation claims into a refund authority.

Automatic share-account cleanup is removed, including for accounts created by
the withdrawal. Even a non-idempotent creation can use lamports pre-funded by
another wallet, so it cannot establish one recipient for the entire balance.
The [associated-token-account program](https://github.com/solana-program/associated-token-account/blob/main/program/src/tools/account.rs)
explicitly tops up pre-existing lamports when creating a PDA account.
Unit tests verify retained accounts with and without an existing ATA, despite
refund hints, and retain exact share-redemption checks. The concurrent-deposit
regression passed on the local devnet fork: B receives no refund and the rent
remains in the owner's empty ATA.

### Ambiguous broadcasts remain recoverable

A `requested` row can already have landed after a crash, an ambiguous RPC
response or an external broadcast. Previously, an expired `BlockhashNotFound`
could fail it immediately, and the sweep failed it on its first missing status.
Broadcast errors now leave the durable intent for reconciliation. The first
expired unknown observation promotes a requested row under a status guard and
records the existing unknown marker. A later finalized observation can recover
it. Regression tests cover recovery and genuine expiry across separate sweeps.
This shared execution correction applies to all vault providers.

### Slippage protection is explicit

Kamino cannot encode a withdrawal `minAmountOut`. Supplying one now returns
`WITHDRAW_REFUSED` before RPC/build, mapped to a caller-facing 400. Floor-less
withdrawals retain their existing contract. Deposit simulation recognizes
`SharesOutBelowMinimum` as a slippage error; an impossible floor was also
verified against the real mainnet program on a local fork.

## Threat analysis and remaining limits

No new signer, authority, dependency, network endpoint or public route was
introduced. Boundaries remain caller to tenant-scoped API, SDK to unsigned plan,
signer to exact compiled message, ledger to broadcaster and RPC to observed
state. Earn remains excluded from the public OpenAPI surface.

- Receipt data is untrusted input at the parser boundary and checked against
  recorded intent. RPC is still a trusted chain-history source: a compromised
  endpoint can lie about execution. Unavailable history leaves explicit unknown
  amounts and retryable repair work, not invented balances.
- A transient status miss is tolerated. Two missing responses from the same
  persistently incomplete endpoint still do not prove non-landing under the
  existing shared expiry policy. Independent archival verification or retaining
  an unknown outcome would require a separate lifecycle policy change.
- Custody-key compromise or a malicious approved provider program can move
  funds. This audit does not certify the custody service or Kamino's programs.
- Kamino withdrawals have no on-chain token-output floor. Gross position value
  is not a guaranteed net payout after fees or penalties. Liquidity, reserve
  losses, oracle behavior, administration and upgrades remain protocol risks.
  Devnet's legacy deposit instruction also lacks mainnet's share-floor support.
- Tenant/project scoping, exact signed-message equality, every required
  signature, one-time build consumption and idempotency remain enforced by the
  existing boundaries and regression suites.

## Validation

| Check | Final result |
| --- | --- |
| Full API suite with coverage | 431 suites passed; 6,709 tests passed, 5 skipped |
| API coverage | Statements 81.36%, branches 71.79%, functions 87.51%, lines 82.09%; all required thresholds passed |
| Kamino offline suite | 154 passed; 2 opt-in fork tests skipped by default |
| API and Kamino typechecks | Passed |
| Changed TypeScript lint and formatting | Passed |
| Migration compatibility, including working-tree files | Passed |
| Module, Kamino dependency and pinned-dependency boundaries | Passed |
| Generated transaction-view drift and API playground drift | Passed |
| OpenAPI and module-map regeneration | Passed; public Earn surface remains hidden |
| Diff whitespace | Passed |

Earlier in this audit, the Earn package suite (197 tests), dashboard withdrawal
amount/modal/slippage checks (25 tests) and production dependency audit also
passed. No dependency version changed afterward.

- Receipt parser tests include partial acceptance with a preceding swap, both
  supported deposit layouts, integer precision above `Number.MAX_SAFE_INTEGER`,
  Token-2022, malformed/excessive amounts, wrong identities, missing metadata,
  duplicate deposits, inconsistent decimals and a violated share floor.
- API regressions cover receipt finalization, historical repair, retry spacing,
  missing history, tenant isolation, observed earnings, ambiguous broadcasts and
  unchanged request identifiers/finality.
- Mainnet local-fork deposit/partial/full withdrawal round trip passed with a
  finalized receipt and retained ATA. Devnet's fixed rent-race regression passed.
  Additional combined runs and the cap-mutation experiment were incomplete due
  to Surfpool upstream account-fetch failures; they are not counted as passes.
  Partial-acceptance accounting is established by deterministic receipt tests,
  not by a successful cap-mutation fork run.

## Rollout, rollback and review gate

Apply the additive migration and regenerated transaction view before starting
the new code. Verify in staging that old projections read as unknown, receipt
repair restores observed values once, and empty share ATAs retain their rent.
Monitor `deposit_receipt_repair_claimed`, `deposit_receipt_repair_repaired`,
`deposit_receipt_repair_unobserved` and `deposit_receipt_repair_errors` on the
existing reconciliation event, alongside its backlog and failure signals.
Persistent missing history requires an operator-supported historical RPC.

Previously issued signed or unsigned transactions retain their original bytes;
new code cannot revoke an externally held signature. During rollout, drain old
builders/broadcasters and wait past the last-valid block heights of old plans
before treating the new refund policy as universal. Preserve signed outbox rows
and continue observing their signatures: expiry never proves an earlier landing
impossible. Validate this drain procedure in staging, including externally
submitted transactions and idempotent retries.

No schema downgrade is needed to roll back the application. The additive schema
accepts old writes, but reverting the application reintroduces its accounting
and rent defects. Prefer a forward fix; a rollback decision must account for
those risks and previously issued transactions. Do not restore guessed amounts
as verified facts or delete durable intents to simplify rollback.

Independent review, internal security review, all applicable CI and staging
rollout/rollback validation remain release gates. No production verification or
exhaustive security certification was performed here.
