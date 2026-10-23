# 0012. Token movements: one model for every amount

Date: 2026-10-22
Status: Accepted. PR 1 lands the foundations (types, Token Terms, quote, checks) and changes no
call site. PRs 2–5 move every path onto them (Rollout).

## Context

"The entered amount is not the sent amount" is a symptom of four gaps.

1. **No model of what an amount means.** Every path converts a decimal string by itself, as
   `value × 10^decimals`, with decimals from a different source each time: the source token
   account, the catalogue, a live mint read, or a constant (`sdp-ondo`). Each path also picks its
   own instruction: Payments uses `transferChecked`, Private Channels uses unchecked `Transfer`,
   Mosaic and the subscriptions program build `TransferChecked` inside their SDKs.
2. **SDP records what it intended, not what happened.** Rows store the entered string. A transfer
   is "confirmed" on signature status alone. Recurring checks instruction data, never what the
   recipient got.
3. **Units are mixed, and no type tells them apart.** Balances return the RPC's `uiAmount` (the
   display value, multiplier included) next to raw amounts. The dashboard checks typed amounts
   against `uiAmount`; the API parses them as raw ÷ 10^decimals. The stable docs call `amount`
   "UI units", which on Solana means the display value.
4. **No single asset identity.** "SOL" and the wrapped SOL mint both become native SOL. The
   security scan found this bug class twice (SOLA9-758, SOLA9-838).

Payments already closed the precision part of gap 1 (#2453, #2473): amounts parse exactly into
u64 base units, a too-precise amount is a 400 before any row is stored, payment requests settle
on an exact recipient balance increase, and new payments refuse interest-bearing, scaled and
non-transferable mints at admission. That refusal is a stopgap: it keeps display-changing mints
out instead of supporting them, and it does nothing for transfer fees, hooks or the other paths.

This is in production scope today. PYUSD and USDG are catalogue tokens, ramp assets and allowed
recurring tokens. On mainnet both carry `TransferFeeConfig` (0 bps, `maximumFee` 0),
`TransferHook` (no program set), `PermanentDelegate`, `ConfidentialTransferMint`,
`ConfidentialTransferFeeConfig` and `MintCloseAuthority` (`pnpm check:well-known-mints`,
2026-10-22). If the fee authority turns the fee on, every flow underpays and still records
success. If a hook program is set, every SDP transfer of those tokens fails. SDP's own issuance
offers scaled UI amount, interest-bearing and transfer-fee mints.

The key fact:

| Extension | Changes the base units moved? | Effect |
|---|---|---|
| Transfer fee | yes | The debit splits into credit + fee, withheld in the destination. Exact, from the mint and the epoch |
| Scaled UI amount | no | Display only: `trunc(raw × multiplier) ÷ 10^decimals`. The multiplier can switch at a timestamp |
| Interest-bearing | no | Display only: `raw × e^(rate·t) ÷ 10^decimals`, changing every second. The rate can be negative |

With a base-unit ledger, two of the three become display rules and the third an exact three-way
split. "Supporting the extensions" means reading them from the chain as token rules and applying
them in one place, not adding special cases to every flow.

## Decision

1. **Base units are the ledger, and units are types.** `@sdp/solana/token-amount` defines
   `BaseUnits` (a u64 bigint) and `TokenAmount` (an exact decimal equal to base units ÷
   10^decimals, with its decimals). `@sdp/solana/token-terms` defines `DisplayAmount` (what a
   wallet shows, with its rule and `asOf`); it never builds or verifies a transaction. Each type
   is branded, and only its constructors make it. These modules are client-safe: no RPC import.
2. **One asset identity.** `AssetRef = { kind: "native" } | { kind: "token", mint, program }`
   (`@sdp/solana/asset-ref`). `resolveAssetRequest(token, cluster)` resolves a request once:
   "SOL" is native, a catalogue symbol is that cluster's mint, the wrapped SOL mint is an SPL
   token, and any other mint is read to learn its program.
3. **Token Terms are read live, once per movement.** `readTokenTerms(asset)`
   (`apps/sdp-api/src/services/token-movement/read-terms.ts`) makes one
   `getMultipleAccounts([mint, Clock])` request, so the fee epoch and display time belong to the
   slot that held the mint bytes. Native SOL makes no request. Nothing is cached: every field
   moves value, and a mint with a close authority can be closed and created again with other
   decimals. The terms hold decimals and program, `readAt` (slot, timestamp, epoch), the fee
   schedule (older and newer), the display rule, the hook program, paused, non-transferable,
   default account state, permanent delegate, confidential transfers, close and freeze
   authorities, and the extensions a new token account needs. A mint the program would refuse
   (an account extension on a mint, scaled and interest together, a fee above 100%) is refused.
4. **The rules mirror the program, `solana-program/token-2022` `interface/src/extension/`.**
   `epochFee`, `feeFor` (`min(ceil(debit × bps ÷ 10 000), maximumFee)`) and `debitForCredit`
   are exact bigint math. The credit never decreases and grows by at most 1 per base unit, so
   every credit is reachable exactly: `debitForCredit` starts from the program's
   `calculate_pre_fee_amount` and confirms it with the forward rule. `toDisplay` repeats the
   program's f64 steps, because wallets and the RPC show what they produce. `fromDisplay` is a
   binary search over all of u64, so it is exact. The pinned client
   (`@solana-program/token-2022` 0.17.0) does not match the program for display (it rounds
   scaled amounts where the program truncates, and orders the interest exponent differently),
   so SDP mirrors the program and uses the client only to decode accounts.
5. **One quote.** `MovementIntent = { asset, amount: TokenAmount, basis: "debit" | "credit" }`.
   `quoteMovement(terms, intent)` returns `MovementQuote { debit, fee, credit, feeEpoch, display,
   asOf }` in base units, with `debit = credit + fee`.
6. **The API's `amount` is token units:** base units ÷ 10^decimals, never a display value.
   Every request amount defaults to basis `debit`. An amount that is a receipt by definition (a
   payment request's amount, a provider's deposit amount) is documented as one, and its flow
   quotes it as `credit`.
7. **One builder** (PR 2) is the only place a token transfer instruction is built:
   `TransferCheckedWithFee(debit, decimals, fee)` whenever a fee config exists, even at 0 bps, so
   a fee change fails on chain instead of settling short; `TransferChecked` otherwise; never
   unchecked `Transfer`. Hook accounts are resolved there. It lives in `@sdp/solana/token-movement`
   (`buildTokenMovement`, `support`, `resolveTransferHookAccounts`), so the surfnet matrix runs it
   and adapters in packages can call it; Payments plans every movement through
   `apps/sdp-api/src/services/token-movement/build.ts` before it records anything.
8. **Every movement path is the builder or a registered adapter** with its own capability row.
   DvP, Private Channels and Earn get "refused" rows for fee and hook mints until their programs
   support them.
9. **Recurring v1 mandates are debit-only, with a fee tolerance.** The subscriptions program
   pulls with plain `TransferChecked` and its cap counts the debit, so a fee has no finite worst
   case. Before each pull the terms are read again; above the tolerance, the collection is held
   with a reason.
10. **Interest-bearing display is shown as approximate, with its `asOf`.**
11. **Verification.** A top-level transfer SDP built is verified by construction: once it lands,
    its debit and fee are what SDP signed. CPI pulls, inbound transfers and provider-built
    transactions are verified from the chain's balance deltas.

## Consequences

- PR 1 changes no behavior: no call site uses the new modules yet.
- **No casts.** `pnpm check:value-movement` fails any `as` or `<T>` assertion to `BaseUnits`,
  `TokenAmount`, `DisplayAmount`, `MovementQuote`, `MovementIntent` or `AssetRef` outside the
  type's own module and tests, in the API, the dashboard and every package. It lands now because
  nothing uses the types yet. The pins on transfer builders and conversion helpers land in PR 5,
  with no allowlist of offenders: each PR moves its paths first.
- **Target RPC budget.** A classic-mint transfer keeps its two reads; the mint read now brings the Clock
  with it. The reader is one request, native none.
- **Ledger (PR 2).** `token_movement_legs` holds one row per (movement, destination): its asset,
  decimals, basis, quoted debit, fee and credit in base units (`debit = credit + fee`), the fee
  epoch, the Clock read and the display rule. A leg belongs to a transfer row (a single transfer,
  an off-ramp deposit) or to a batch recipient, whose chunk row carries the signature. Its quote
  is sealed once that signature is saved. A new row's `amount` text is written only from the
  quote. Rows written before quotes have no leg; there is no backfill.
- **Verification by construction (PR 2).** The statement that settles a movement SDP built writes
  its legs' verdict: `verified` when it confirms, `not_required` when it fails or is released.
  No extra `getTransaction`. Transfer status values do not change.
- **Builder refusals (PR 2).** Paused, non-transferable and frozen-by-default mints (until the Token
  ACL thaw, PR 4), an unresolved hook, a memo-required destination with no memo, and a fee that
  leaves nothing to credit are refused with `400` before the movement is recorded.
- **Payments' stopgap, transfers (PR 2).** Single transfers, batches and off-ramp funding leave
  `loadPaymentMint`: the quote parses exactly in u64 against the live decimals, and `support`
  refuses a non-transferable mint. Interest-bearing and scaled mints move there in token units.
  /pay keeps the stopgap until PR 3, recurring until PR 3.
- **Mint watch.** `pnpm check:well-known-mints` decodes every catalogue mint with the same
  decoder, prints its extension state, and fails when a 1 000-token transfer would pay a fee
  under the current or the newer fee entry (bps alone is not the signal, since `maximumFee` is
  0), or when a hook program is set. While Payments still refuses display-changing mints, it
  also fails on an interest-bearing, scaled or non-transferable catalogue mint. CI runs it only on
  pull requests that touch the catalogue or the script, because it uses public RPC.
- **Mint matrix.** `packages/sdp-solana/src/test/mint-matrix.ts` creates one mint per profile
  on an embedded offline surfnet: classic, Token-2022 plain, fee 0 bps, fee 50 bps with a cap,
  scaled 1.5×, a scaled multiplier switch, interest ±5%, a hook program set, paused, and frozen
  by default. `pnpm token-movements:surfpool:e2e` checks the decoder and the rules against the
  program: real transfers move exactly the quoted debit, fee and credit; `toDisplay` equals the
  program's `AmountToUiAmount`; the account size matches; a stale fee after an epoch change is
  refused. It needs no network or secret but is not in CI yet. Surfpool 1.5.0's RPC leaves the
  interest rate out of `uiAmountString` and keeps an old multiplier after a time travel, so the
  program's own instruction is the display reference there.
- A client at `@solana-program/token-2022` 0.20.0 or later matches the program's display math.
  When the catalogue moves to it, `toDisplay` may call it; the program's test vectors in
  `token-terms.test.ts` guard that change.

## Rollout

Each PR ships alone.

1. **Foundations** (this PR): this ADR, the amount types and pure rules, Token Terms decode and
   reader, the asset resolver, the mint matrix on Surfpool, the cast ban, the mint watch.
2. **Ledger and builder:** the `token_movement_legs` schema, the builder, transfers, batches and
   off-ramp funding on it, and the API amount shape (`amountBasis`, `amounts`,
   `amountVerification`).
3. **Payment requests and recurring:** requests settle on the signatures SDP issued; recurring
   moves to debit mandates with a fee tolerance and pre-pull holds.
4. **Adapters:** issuance, the DvP, Private Channels and Earn refusal rows, the capability table
   with its Kora CI test, observed inbound transfers, on-ramp.
5. **Display and finish:** balances, the terms and quote routes, `uiAmount` stripped at the RPC
   boundary, the generic amount helper split from token conversion, the check-script pins, and
   validated constraints.

## Open decisions

1. **Stable docs wording.** "UI units" becomes "token units (base units ÷ 10^decimals); see
   `amounts.display` for wallet display" in PR 2. This is a stable-surface change and needs
   sign-off. For classic mints, and for every movement SDP has made so far, the values do not
   change.
2. **Mint watch schedule:** where it runs and who gets the alert.
3. **Credit-basis recurring mandates**, after v1.
4. **When the DvP, Private Channels and Earn refusals lift:** when those programs support
   `TransferCheckedWithFee` and hooks.
5. **Token ACL gating:** PR 2 refuses mints that open accounts frozen; PR 4 adds the
   permissionless thaw and lifts the refusal where the mint is gated.
6. **Issuer operations** (update a multiplier or fee, harvest withheld fees) are out of scope;
   Token Terms can support them later.
