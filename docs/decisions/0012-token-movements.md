# 0012. Token movements: one model for every amount

Date: 2026-10-22
Status: Accepted. PR 1 lands the foundations (types, Token Terms, quote, checks) and changes no
call site. PRs 2–4 move every path onto them, and PR 5 adds display and turns enforcement on
(Rollout). Sign-offs still open are listed under "Open decisions".

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
   token, and any other mint is read to learn its program. Payments refuses the wrapped SOL mint
   with `400` (`resolvePaymentAsset`): its rows and balances still store native SOL under that
   mint, so a wrapped SOL move would read back as native SOL.
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
  `TokenAmount`, `DisplayAmount`, `MovementQuote`, `MovementIntent` or `AssetRef`, and any
  `as never` or `as any` that lands in one, outside the type's own module and tests, in the API,
  the dashboard and every package. It lands now because nothing uses the types yet. The pins on
  transfer builders and conversion helpers land in PR 5.
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
  ACL thaw, PR 4), interest-bearing and scaled mints (until PR 5), an unresolved hook, a
  memo-required destination with no memo, and a fee that leaves nothing to credit are refused
  with `400` before the movement is recorded.
- **Payments' stopgap, transfers (PR 2).** Single transfers, batches and off-ramp funding leave
  `loadPaymentMint`: the quote parses exactly in u64 against the live decimals, and `support`
  refuses a non-transferable mint. `support` still refuses interest-bearing and scaled mints:
  balances and the dashboard show their display amount until PR 5, so a user would type one
  amount and move another. /pay keeps the stopgap until PR 3, recurring until PR 3.
- **Payment requests (PR 3).** A request stores its expectation, the credit in base units with
  the asset and decimals read at creation (migration 0162); an amount with more decimals than the
  mint, or a mint the builder refuses, is a 400 then. /pay quotes that credit under the terms it
  reads and builds with `buildTokenMovement`; the Solana Pay reference is the transfer
  instruction's last account, after any hook accounts. Each claim window records its issued
  transaction and quote (`payment_request_transactions`); the sponsor signs first, so its
  signature is the transaction id. Settlement reads only those signatures, every window still
  `open`, and closes a window that landed, failed, or has no record past its blockhash's last
  valid block height (the `readSavedSend` rule). A landed one is verified by construction. The
  claim refuses an expired request, and a new window while a signed one is still open, which may
  have landed in its last blocks; settlement refuses a request whose expiry came before the
  paying transaction was issued. `findReference` and main's `validatePaymentRequestTransfer` are
  gone (SOLA9-699). /pay leaves `loadPaymentMint`; a scaled or interest-bearing mint is still
  refused, at creation and at /pay, since the builder refuses it until PR 5.
- **Recurring mandates (PR 3).** A recurring payment and its plan store the mandate once: the
  debit in base units, the decimals and the fee tolerance (`maxFeePerPull`, the larger of the
  current and next epoch's fee for the debit; migration 0163). Each pull reads the terms once
  before its claim; a paused mint, a fee above the tolerance or a destination that requires memos
  holds it as a `failed` attempt with `holdReason`, the period still due. A pull the cron finds
  still held once its period has ended skips the period, as the subscriptions program forfeits an
  elapsed period's allowance. Activation refuses a memo-required destination. A pull's leg is
  `verified_by` the chain (migration 0164): its observed debit is the instruction's amount and its
  credit the destination's raw balance delta, read from the `getTransaction` the collection proof
  already makes. It is verified when that debit is the quote's and the fee is within the
  tolerance, which a pull landing in the next epoch may pay instead of the quote's fee. Create,
  plan create and an update that changes the token or amount make the mandate before any row (the
  precision check `loadPaymentMint` made); token admission stays start admission, so cancel and
  recovery never ask it. Interest-bearing and scaled mints are still refused until PR 5: the
  recurring row takes the builder's refusals.
- **One capability table (PR 4).** `support(terms, path)` answers from one table with a row per
  path: `builder` and the adapters `recurring` (PR 3's row), `issuance` (mint, burn),
  `issuance_seize`, `dvp`, `private_channels` and `earn`; `capabilityRefusals` lists every
  refusal with its extension and disposition. Every refusal is a `refuse` except the recurring
  row's paused mint, a `hold`; a row lists its refusals before its holds. DvP's create check and
  form inspection, its reclaim's hook check and the Earn deposit-mint guard decide on their rows;
  no module keeps its own extension set. A CI test (`kora-sponsor-policy.test.ts`) pins the
  builder row to `infra/kora/kora.toml`.
- **Token ACL thaw (PR 4).** A frozen-by-default mint whose freeze authority is its Token ACL
  config moves through the builder: a destination the movement creates gets the config's
  permissionless thaw right after its create (`resolveTokenAclThaws`), as Mosaic's transfer
  does, and /pay gets the same thaw, signed by the payer. Other frozen-by-default mints move
  only to an account their authority thawed; one with no freeze authority, and an existing
  frozen destination, are refused. The recurring row still refuses every frozen-by-default mint
  (the program's CPI cannot thaw), and a pull to a frozen destination is held
  (`destination_frozen`). The Token ACL program is not on the offline surfnet, so the thaw is
  covered by unit and route tests.
- **Adapters (PR 4).** Issuance hands Mosaic a number only after reading the mint live, asking
  its row and checking that Mosaic's own conversion gives back exactly the amount's base units
  (`@sdp/solana/mosaic-amount`); a seize on a fee mint debits the amount and the destination
  receives it less the withheld fee. DvP funding is built by the builder. Private Channels writes
  read the mint with the allowlist entry and convert at its live decimals. Earn's guard reports
  `earn_support` drift; its builders read no deposit mint, so it does not block a build.
- **Chain verification (PR 4).** Observed transfers and on-ramp deliveries are judged from base
  units: instruction data (`transferCheckedWithFee` included) against the raw balance change,
  never `uiAmountString`. An on-ramp's reported amount may equal the observed credit, or the
  observed debit when the fee rule explains the difference; a verified delivery records its leg,
  `verified_by` the chain, in the statement that completes it. A built off-ramp deposit whose
  confirmation timed out settles when the verifier sees it final.
- **Mint watch.** `pnpm check:well-known-mints` decodes every catalogue mint with the same
  decoder, prints its extension state, and fails when a 1 000-token transfer would pay a fee
  under the current or the newer fee entry (bps alone is not the signal, since `maximumFee` is
  0), or when a hook program is set or the mint is non-transferable. PR 5 drops the stopgap's
  refusal of interest-bearing and scaled catalogue mints, as it lifts the builder's refusal of
  them. CI runs it on pull requests that touch the catalogue, the decoder or the script, because
  it uses public RPC, and daily (`.github/workflows/well-known-mints-watch.yml`, PR 1): a failure
  fails the run and posts to the alert Slack channel. The daily run never gates a pull request.
- **Mint matrix.** `packages/sdp-solana/src/test/mint-matrix.ts` creates one mint per profile
  on an embedded offline surfnet: classic, Token-2022 plain, fee 0 bps, fee 50 bps with a cap,
  scaled 1.5×, a scaled multiplier switch, interest ±5%, a hook program set, paused, and frozen
  by default. `pnpm token-movements:surfpool:e2e` checks the decoder and the rules against the
  program: real transfers move exactly the quoted debit, fee and credit; `toDisplay` equals the
  program's `AmountToUiAmount`; the account size matches; a stale fee after an epoch change is
  refused. It needs no network or secret but is not in CI yet. Surfpool 1.5.0's RPC leaves the
  interest rate out of `uiAmountString` and keeps an old multiplier after a time travel, so the
  program's own instruction is the display reference there.
- **Display values stop at the RPC layer (PR 5).** `@sdp/rpc/solana`'s `SolanaRpc` type replaces
  kit's token reads: `getTokenAccountsByOwner` and `getTokenAccountBalance` return `RpcTokenAmount`
  (base units and decimals) and the token reads SDP does not make are left off, so a use of
  `uiAmount` or `uiAmountString` fails typecheck. The local copies that named them (Private
  Channels' gateway, Helius DAS) are gone, and `check:value-movement` refuses any reference to the
  two fields of kit's `TokenAmount` outside `packages/sdp-rpc/src/` (a transaction's
  `uiTokenAmount` included). The issuance supply refresh reads the supply from the mint account
  instead of `getTokenSupply`.
- **Balances in three units (PR 5).** Every balance carries `amount` (base units summed over the
  wallet's accounts of the mint), `tokenAmount` (exact token units) and `displayAmount`,
  `displayAsOf` and `displayRule`, computed from the summed base units under the mint's terms
  (`services/token-movement/balance-display.ts`). This fixes a wallet with several accounts of one
  mint showing its first account's RPC value. A classic SPL mint or native SOL shows its token
  amount with no read. Every Token-2022 mint a balance request holds, across all its wallets, is
  read in one `getMultipleAccounts` with the Clock (99 mints per request, pages in parallel). The
  custody wallet list and aggregate, whose holdings are cached for 10 seconds, keep each mint's
  terms per cluster as long and join a read already running, so the home page's two reads make one
  terms read; a failed read is never kept. A balance read after a transfer (a deadline and a slot
  floor) reads the terms live. `displayAsOf` says when they were read. A Token-2022 holding whose
  mint does not decode, or whose display overflows the program's f64 math, is left out and logged:
  anyone can send a wallet such a token. An aggregate sums base units per mint (native SOL and
  wrapped SOL as one, as the dashboard keys it) and shows the display of the sum. `usdValue` prices
  `displayAmount`. The old `uiAmount` field is removed, not kept beside the new ones, which is
  acceptable only before launch.
  Private Channels balances report `tokenAmount` (SPC accounts are classic); Earn's share
  reconciliation compares base units and makes no terms read.
- **Terms and quote routes (PR 5).** `GET /v1/tokens/{mint}/terms` reports decimals, program, the
  fee entries in force this epoch and next, the display rule, the flags, and every movement path
  the deployment runs with its refusals (`capabilityRefusals`; Earn's path stays out while
  PRO-2038 holds it). `POST /v1/tokens/{mint}/quote` takes `amount` (token units) or
  `displayAmount` and a basis, and returns the token amount, `amounts` and `expiresAt`: 60 seconds
  after the read, never later than a pending multiplier switch. A display debit converts with
  `fromDisplay(atMost)`, a display credit with `atLeast`. Both are Payments reads under
  `transfers.read`, metered as `token-terms` (60/min per credential, 240/min per organization),
  one `getMultipleAccounts` each; the quote is a POST that stores nothing and takes no
  Idempotency-Key.
- **Dashboard (PR 5).** Balance checks and every "Max" use `tokenAmount`; screens show
  `displayAmount`, with "≈" and its time for an interest-bearing mint. The single send and the
  payment request form let a scaled or interest-bearing mint's amount be typed in display units,
  quote it, show the token amount, fee and credit, and submit token units; a fee mint shows its
  fee and credit preview.
- **Unified view (PR 5).** A Payments row's amount comes from its legs when it has them (outbound:
  the quoted debit; inbound and off-ramp: the credit; a batch chunk: its recipients' debits);
  a row without a leg keeps its stored text. A verified on-ramp delivery's transfer `amount` is
  its leg's credit too.
- **Generic math and token conversion are apart (PR 5).** `@sdp/solana/amount` is generic
  fixed-point math (`parseFixedDecimal`, `formatFixedDecimal`); base units ↔ token units go
  through `@sdp/solana/token-amount` only.
- **Enforcement (PR 5).** The `token-movement-*` capabilities in `check:value-movement` pin every
  token-program transfer builder (both programs, `WithFee`, the hook variant, the
  transfer-to-ATA plans and the client plugins), `@solana/pay`'s `createTransfer`, the unchecked
  `Transfer` and SPC's transfer builder, Mosaic's mint, burn, force-burn, force-transfer,
  transfer and fund-lock builders and `decimalAmountToRaw`, the subscriptions program's pull and
  mandate builders, and the Token-2022 client's display math, to the builder and the registered
  adapters, each with its reason in the script. They scan the dashboard too. Adding an entry is a
  security-reviewed change. `MosaicService.transfer` and `prepareTransfer` are deleted.
- **Recurring activation (PR 5)** refuses a destination whose token account is frozen
  (`destination_frozen`), as it refuses one that requires memos.
- **Validated constraints (PR 5).** Migration 0165 validates the CHECKs 0162–0164 added
  `NOT VALID`.
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
   boundary, the builder's refusal of interest-bearing and scaled mints lifted, the generic amount
   helper split from token conversion, the check-script pins and validated constraints. Merge it
   only after PR 3's migrations (0162–0164) are in production past their rollback window, since
   0165 validates their CHECKs.

## Open decisions

1. **Sign-offs before PR 5 merges.** Each is a stable-surface or security-reviewed change:
   - the stable docs' "UI units" wording becomes "token units (base units ÷ 10^decimals)"
     (PR 2 started it; PR 5 finishes the balance, issuance and concepts pages). For classic
     mints, and for every movement SDP has made so far, the values do not change;
   - the balance responses' `uiAmount` is removed for `tokenAmount`, `displayAmount`,
     `displayAsOf` and `displayRule` (a breaking change to a stable response, acceptable only
     before launch);
   - `GET /v1/tokens/{mint}/terms` and `POST /v1/tokens/{mint}/quote` join the public OpenAPI
     document (AGENTS.md: a named security sign-off);
   - every `token-movement-*` allowlist entry in `scripts/check-value-movement.mjs`.
2. **Mint watch alerts:** decided in PR 1 (daily, Slack on failure). Open: whether a fee or hook
   finding should also hold the affected token's flows automatically.
3. **Credit-basis recurring mandates**, after v1.
4. **When the DvP, Private Channels and Earn refusals lift:** when those programs support
   `TransferCheckedWithFee` and hooks.
5. **Token ACL gating:** decided in PR 4 (see Consequences). Open: whether the builder should
   also thaw an existing frozen account of a Token ACL mint, which would undo an issuer's freeze
   the gate allows.
6. **Issuer operations** (update a multiplier or fee, harvest withheld fees) are out of scope;
   Token Terms can support them later.
7. **The subscription collect route** (`POST /v1/payments/subscriptions/{id}/prepare-collection`)
   builds an unsigned pull of the stored debit for the puller to sign without the job's pre-pull
   terms read and fee-tolerance hold. It is registered as a recurring adapter; whether it should
   share the job's hold is open.
