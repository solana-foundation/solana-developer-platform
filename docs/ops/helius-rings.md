# Helius Rings — operations reference

Devnet-only shielded wallets bound to SDP custody. Shield (deposit), withdraw
and private transfer are built for the default ring and for custom rings, merge
is built for the default ring, and ring moves (`ring_exit` / `ring_entry`)
carry a wallet's own funds between a custom ring and the default ring.
Anonymous transfers, zones and timelocks are not.

The SDK runs in-process behind `RingsGatewayPort`. No adapter switch, no sidecar.

## Architecture

```
routes (/v1/helius-rings)
  └─ HeliusRingsService
       ├─ repositories (Postgres)
       ├─ signer / RPC adapters
       └─ RingsGatewayPort → @sdp/helius-rings-sdk
```

## Configuration

Rings upstreams are project-owned database connections. Open the Helius Rings
dashboard for a project and save a named connection containing the Solana RPC,
Photon indexer, prover, and optional custom Ring RPC URLs. The first active
connection becomes the project default. URLs are encrypted through the shared
provider-credential store; API and dashboard responses expose origins only.

The project default is shared by the default ring and every custom ring in the
project. Custom-ring records contain ring-specific on-chain metadata, not
upstream URLs or a connection selector.

Each operation records the connection selected when it is prepared. Retries and
background settlement therefore keep using the same upstream bundle even if an
administrator later changes the project default. The optional custom Ring RPC
field is stored now so custom-ring support can use the same project-wide
configuration without changing this schema.

| Variable | Meaning |
| --- | --- |
| `HELIUS_RINGS_ENABLED` | Gates routes, dashboard, indexing poll. Default `false`. |
| `SOLANA_NETWORK` | Must be `devnet`. |

> **The seed is public.** Identities derive from `INSECURE_TEST_SEED_DEVNET_ONLY!!`
> in `packages/sdp-helius-rings-sdk/src/deterministic-ka/seed.ts`. Devnet only.

Missing setup → the dashboard shows the configuration form; direct port methods
fail with `config_error`.

## State machine

```
draft → preparing → approval_required → proving → ready_to_sign
      → submitted → indexing → completed
```

Terminal: `completed`, `failed`, `voided`.

`failed` rows carry `failure_code`, `failure_message`, `retryable` (DB CHECK).
Transitions are CAS under `SELECT … FOR UPDATE`.

## Failure codes

| Code | Retryable | Meaning |
| --- | --- | --- |
| `policy_denied` | no | Policy denied the operation. |
| `approval_rejected` | no | Approval rejected, canceled, or expired. |
| `proof_failed` | yes | Prover error. |
| `signer_failed` | varies | Custody signing failed; also used when `ready_to_sign` ages out (10 min) before a signature was recorded. |
| `submit_failed` | yes | RPC submit error (provisioning only in practice). |
| `indexing_timeout` | yes | Unsigned rows: Photon did not index within 30 minutes. |
| `manual_reconciliation_required` | no | Signed bytes exist and neither the indexer nor the chain has a record of them. Operator rechecks or voids. |
| `config_error` | no | Upstreams missing or gateway misconfigured. |
| `gateway_unavailable` | yes | Port unreachable or transient upstream failure. |
| `invalid_input` | varies | Bad input or inconsistent row. |
| `insufficient_balance` | no | Not enough shielded balance. |

## Withdraw (SOL)

Spends consume notes and need a proof. The pipeline:

1. **Prepare** — spend-slot preflight; reserve intent.
2. **Build + prove** — sync wallet at `requireSlot`, select notes, prove in one port call.
3. **Persist outbox** — `signed_transaction`, `last_valid_block_height`, `input_notes` before broadcast.
4. **Sign + submit** — custody signs; `submission_started_at` set; broadcast.
5. **Index** — Photon completes the operation.

Rebuilds pass `pinnedInputs` from stored `input_notes`.

Partial unique indexes serialize one in-flight spend (or unsettled signed deposit) per
wallet. A signed failure holds the slot until completed or voided.

### Recheck and manual void

A row reaches `manual_reconciliation_required` (non-retryable) only once the
sweep has asked both the indexer and the chain and neither accounts for its
signature. The row then offers two actions:

- **Recheck** — `POST /operations/:id/recheck`, no body. Asks the indexer again
  and completes the row on a hit. It can never conclude absence, so it is safe
  to press repeatedly, and an indexer lagging the chain is the likelier
  explanation than a transaction that never landed.
- **Void** — `POST /operations/:id/void` with `{ signature }` matching
  `outer_tx_signature`. Asserts the transaction never landed: CAS
  `failed → voided`, releasing the spend slot. A fresh indexer read backs the
  assertion at commit time and refuses the void if the transaction turns up.

Never void a signature the chain confirms; wait the indexer out instead.

## Assets a spend can name

Two, on either rail: native SOL and devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). The pair is
`PROTOCOL_SPEND_MINTS` in the SDK, and the route schema, the builders and the
wire policy each assert it independently. It is narrower than the
`helius_rings_assets` catalogue on purpose: a spend needs a settlement path
this code can both assemble and re-derive, and only these two have one.

A **USDC withdraw** is the only operation whose outer transaction changes
shape, on the default ring and on a custom ring alike.
`resolveWithdrawalSettlement` derives the mint's vault PDA
(`getSplAssetVaultAddress`, with the bump recovered by re-deriving over
`["spl_asset_vault", mint]` and asserting equality) and the recipient's
associated token account, then emits three instructions instead of two: the
compute limit, an **unconditional idempotent** create for that token account,
and the pool transact. Unconditional because the builder makes no chain read —
one fixed wire shape is what lets custody's policy verify it. Settlement
accounts are the pool's CPI authority, the mint, the vault, the recipient's
token account and the Token program — never `SOL_INTERFACE` and never the
recipient's system address.

A **ring** USDC withdraw carries the same three instructions and the same five
settlement accounts: zolana derives both rails from one `settlementAccounts`.
The one difference is where the accounts live in the message. A ring transact
is compressed over the ring's lookup table, which holds the pool's CPI
authority and both Token programs, so those arrive as lookups; the mint, the
vault and the recipient's token account, which no table names, stay static.
`validateRingSpend` splits the two groups on the table's contents rather than
on the asset, so an account that changes sides is a mismatch either way.

One ring cannot do this: a ring whose lookup table was rented before zolana
0.1.6 appended the settlement group. SOL spends over such a table still work,
but a USDC withdraw would have to name the CPI authority and the Token program
as static keys, and custody refuses that shape. Bring-up is what rents a table
and custody signs no second extend, so an affected ring stays SOL-only.

Watch the packet limit here. A ring transact verifies two proofs and is the
largest transaction this build emits; a USDC withdraw adds an instruction and
three static keys the table cannot absorb. Zolana's `checkedTransactionSize`
refuses an oversized build rather than emitting one, so the failure would be a
build error on a wide note selection, not a broken signature.

**USDC merge and USDC private transfer** keep the SOL wire shape: a merge
publishes no mint and a registered transfer settles nothing publicly, so the
asset is visible only in the approved intent and in the proof the circuit
checks, never in an account the policy could bind it to.

Out of scope: mainnet USDC (a different mint, and nothing has exercised the
pool's SPL interface there) and Token-2022 mints. Nothing narrows by rail: the
same two mints shield, merge, transfer and withdraw on the default ring and on
a custom ring.

If a USDC shield fails with `InvalidSettlementAccounts` (custom 7009), the
pool's `splAssetRegistry`/`splAssetVault` PDAs for that mint do not exist on
the cluster. Confirm with
`pnpm exec tsx packages/sdp-helius-rings-sdk/scripts/verify-usdc-pdas.ts`; it
is a deployment gap, not an SDP bug, and withdraw cannot land until it is
closed.

## Broadcast ambiguity (shield)

RPC submit errors do not prove failure. For **unsigned** shield rows the pipeline
still advances to indexing when possible. Rows **with signed bytes** persist the
outbox first so the same bytes can be resubmitted after a lost RPC response.

## Idempotency and retries

- `intent_key = sha256(walletId, opType, canonical(input), clientNonce)` — replay
  returns the existing operation.
- Retry files a **new** operation (`retry_of_operation_id`), re-runs policy, cap 5
  deep. Never retry a signed failure — void or reconcile instead.
- The link is returned on both the summary and the detail, so Activity names each
  end ("Retry of …", "Retried as …") and stops offering Retry on a failure that
  already has one. The cap counts ancestors, not siblings, so nothing server-side
  refuses a second retry of the same failure.
- `POST /operations/:id/execute` and `POST /operations/:id/recheck` have no
  trusted body.

## Settling an operation

`runPipeline` returns as soon as the broadcast succeeds, so an operation ends
the request in `indexing`. Only `executeOperation` completes it, by asking
Photon, and two things call it:

- The dashboard, every 4s while a row is `indexing` and the page is open. This
  is what makes the UI track the chain rather than the cron.
- `poll-rings-indexing`, as the backstop when no one is watching.

Without the first, settlement latency is the sweep's period, not the chain's:
up to a minute in-process and up to five on Cloud Run, on an operation that
confirmed in seconds. The dashboard nudges `indexing` only — on a `ready_to_sign`
row with no bytes the same call concludes signing died and fails it.

## Background jobs

`poll-rings-indexing` (every minute in-process; every 5 min on Cloud Run) runs
three passes per tick:

1. **Expired bytes** — signed rows past `last_valid_block_height` get one Photon
   check, then a `getSignatureStatuses` check with history search, and only a
   signature the chain cannot account for becomes
   `manual_reconciliation_required` (non-retryable). A transaction the chain
   confirms stays in `indexing` however far behind the indexer has fallen, and
   one the chain could not be asked about waits for the next tick. The whole
   pass is skipped when the chain height is unavailable.

   The chain check is what makes the pass safe on a shield, which records only
   a floor for its expiry because the SDK builder fetches its own later
   blockhash and so reaches this pass while still valid. Without it, an indexer
   stalled behind the chain failed finalized deposits as unresolvable.
2. **Indexed failures** — a signed failure Photon now holds is completed. Never
   the reverse: absence from the indexer never voids anything.
3. **In-flight** — advance `submitted` → poll (crash recovery) and poll
   `indexing` via `verifyIndexed`. A crashed `proving` rebuilds; a
   `ready_to_sign` resends its bytes, or fails `signer_failed` (retryable) if it
   has none. Stale `indexing` then times out: unsigned → `indexing_timeout`
   (retryable); signed → `manual_reconciliation_required` (non-retryable), and
   only once the same chain check has spared whatever the chain vouches for.

   Reads `proving` onward only. `preparing` and `approval_required` hold no
   spend slot and block nothing, and an approval waits on a person, so including
   them would let rows the sweep cannot advance fill its 100-row budget
   oldest-first and starve the ones it exists to settle.

   A row with no signed bytes is skipped until it is older than
   `RINGS_UNSIGNED_GRACE_MS` (2 min). The pipeline builds, proves and signs
   inline and takes no lease, so without the grace a tick landing mid-request
   fails the operation out from under it — a live withdrawal reports "signing
   did not complete" while custody is still holding the request. Rows with
   bytes have no grace: resending them is idempotent.

Enabled when `HELIUS_RINGS_ENABLED=true`.

## What ships

| Flow | Upstreams unset | Configured |
| --- | --- | --- |
| Provisioning | 503, wallet `pending` | On-chain register, wallet `ready` |
| Sync | 503 | On-demand from dashboard |
| Shield | `failed:config_error` or `gateway_unavailable` | Build, sign, broadcast, index |
| Shield (custom ring) | same; also needs a Ring RPC URL in project setup and an active ring | Ring-bound deposit through the ring program |
| Withdraw (SOL) | same | Note selection, prove, outbox, sign, broadcast, index |
| Withdraw / transfer (custom ring) | same; needs the ring active with its lookup table | Ring transact through the SDK's one-call builders, ALT-compressed; a USDC withdraw adds the token-account create |
| Merge (SOL, default ring) | same | Clears the on-chain merge gate, selects 2–5 notes, proves, signs, broadcasts, indexes |

## Custom rings

Named custom rings, no fixed cap per project. A custom ring is its own
on-chain program: deposits into it are ring-bound, so only that ring's own
instructions can ever spend the notes, and every ring transfer carries a
message the ring's auditor key can decrypt. Ring membership is a property of
each note, not of a wallet — one private wallet holds default-ring notes and
notes of several rings side by side. SDP operates a ring but does not deploy
its program.

### Ops runbook: deploying a project's ring program

The whole sequence is scripted: `scripts/deploy-custom-ring.sh` creates a
custody wallet through the API, deploys the release ring binary (sha256
pinned), hands the upgrade authority to that wallet, and funds it for
bring-up. It needs a project API key with `custody:admin` (not wallet-scoped)
and resumes from where it stopped on re-run:

```
SDP_API_KEY=sk_... scripts/deploy-custom-ring.sh <ring-label>
```

Then record the printed program id under a name in the dashboard's *Custom
rings* card. The manual steps below are the reference for what the script
does.

1. Get the `zolana-ring` CLI from the `custom-rings` release of
   [`helius-labs/zolana`](https://github.com/helius-labs/zolana).
   `zolana-ring new` writes the ring's `ring.toml` and program keypair —
   each ring gets a distinct program id.
2. Deploy to devnet with `zolana-ring deploy`. The CLI deploys under the
   operator's own keypair, hash-verifies the released binary before deploying
   and the on-chain bytes after; it cannot set a foreign upgrade authority,
   and its `authority transfer` refuses to run before `init`. Do not run
   `zolana-ring init` — bring-up is SDP's init, and a ring initialized by the
   operator keypair can never be adopted by custody. Hand the program to
   custody with the Solana CLI instead:

   ```
   solana program set-upgrade-authority <program-id> \
     --new-upgrade-authority <custody wallet address> \
     --skip-new-upgrade-authority-signer-check
   ```

   Copy the custody address exactly — only the current authority can ever
   change it again. Bring-up signs as that authority through custody, so a
   program whose authority custody does not hold cannot be brought up. Fund
   the wallet with devnet SOL first — it fee-pays every bring-up transaction
   and rents the config, ring-auth, reader-record, and lookup-table accounts.
3. Hand the program id to the project admin. They enter it with a name in the
   dashboard's *Custom rings* card (or `POST /v1/helius-rings/rings`).

SDP then completes bring-up through the SDK: an auditor key from the Ring RPC
saved in project setup, the ring's create-config instruction, its
shielded-pool registration, a read grant naming the config authority as the
ring's initial reader, and the ring's address lookup table — each signed
through custody and confirmed on chain. The table holds exactly
`ringLookupTableAddresses(ring, tree)` (custody refuses to sign any other
extend, and the wire policy re-derives that list locally for every ring
spend); the chain requires it to be at least one slot old before a spend
compresses through it, which bring-up and a first spend being human-time apart
always satisfies. The recorded ring row moves `pending → active`, with any
failure recorded on the row.

### Semantics worth knowing

- **Per-operation selection, by name.** Every enabled operation may name a
  ring (`ring: "<name>"`, omitted or `"default"` = the default ring). On a
  shield the ring is the destination; on a withdraw or private transfer it is
  the source of funds — the spend consumes only that ring's notes, through the
  ring's own transact instruction. Default-ring operations and sync are never
  blocked by any ring's state. An unknown name is a `400` and a recorded but
  not-yet-active ring a `503` (`config_error`); the resolved program id is
  pinned on the operation row at prepare time and never re-resolved, so an
  approval granted days later — and any retry — runs against the ring the
  reviewer saw. The pinned ring also joins the intent key: the same operation
  aimed at a different ring is a second operation, not a replay.
- **Ring moves (`ring_exit` / `ring_entry`).** The wallet's own shielded SOL
  crosses between a named custom ring and the default ring in one transact:
  `ring_exit` spends ring-bound notes into the wallet's own default-ring note,
  `ring_entry` spends default-ring notes into a ring-bound one. `ring` is
  required and never `"default"` — the other side of every move is the default
  ring. Self-only by construction: entry's recipient is hardcoded to the
  sender inside the SDK builder, and exit's recipient is the wallet's own
  shielded address lifted from the material scope already open for the build.
  Both are spends and share the one-in-flight-spend-per-wallet slot. Value
  stays shielded the whole way — no hop through the public custody address.
  `ring_entry` is the first operation consuming default-ring notes through a
  one-call builder, so the pinned-input/prepared-intent contract of default
  spends does not apply to it; it carries the same rebuild posture as ring
  spends (empty `input_notes`, signed bytes immutable).
- **Ring spends have no pinned-input contract.** The SDK's one-call ring
  builders select same-ring notes internally on every build, so `input_notes`
  persists empty and a pre-sign rebuild may spend different notes than the
  failed attempt (default-ring spends keep their deterministic
  pinned-notes rebuild). Duplicate payment stays gated by the signed-bytes
  line: once bytes are signed, recovery only ever resends them.
- **What custody's wire gate can and cannot prove on a ring spend.** It proves
  the right ring program, the right tree, the ring's pinned lookup table, the
  exact account universe, a single owner signature, and the public settlement
  (none on a transfer or a ring move; exactly the approved recipient and
  amount on a withdraw). On a ring TRANSFER — and on a ring move, whose wire
  is transfer-shaped — the recipient, amount, and destination pool live inside
  encrypted outputs and cannot be re-derived from the wire — the
  pre-encryption prepared-intent check that binds them on default spends is
  bypassed because the one-call builders never expose the prepared transfer.
  Accepted because the transaction is built in-process against the approved
  persisted intent and the recipient is a same-tenant wallet's shielded
  address (on a move, the wallet's own).
- **Resume, never re-key.** Bring-up is idempotent against on-chain state:
  re-submitting the same name and program id resumes from whatever already
  landed. An existing on-chain config is adopted as it stands — re-keying a
  live ring would orphan its auditor — but only when the program's upgrade
  authority IS the config authority: a program another party can upgrade
  could swap the code the notes deposit under, so it is refused with a `409`.
  Adopting a fully-registered ring lands no ring-program transaction, so
  custody additionally proves it holds the config authority by signing a
  challenge; a ring administered by someone else's key is the same `409`. A
  recorded lookup table is adopted when live and complete; one that exists
  but lacks the ring's addresses was not created by this bring-up and is
  refused.
- **No re-pointing once active.** Re-submitting a recorded name with a
  different program id replaces a ring that never went active (a mistyped id
  binds no notes, so correcting it strands nothing) and is a `409` once the
  ring is active. Names and program ids are both unique per project: a name
  resolving to two programs would pin the wrong ring, and one program under
  two names would split one ring's audit trail.
- **Balances are tagged per ring.** Sync returns every unspent note the wallet
  holds, grouped by `ringProgramId` (`null` = the default ring). The
  groups never merge into one number: value cannot cross a ring boundary
  inside a spend, so a merged figure would overstate what any single operation
  can move. Each group also carries a `noteCount`, which is what tells an
  operator a position is fragmented and a merge would help.
- **Auditor key.** Held by the Helius ring RPC, never by SDP; the config's
  public half is recorded on the ring row and echoed by `GET /rings`.
- **Merge consolidates, it does not move.** A merge spends 2–5 of a wallet's
  own notes for one asset and writes back a single note worth their sum. It
  takes no amount and no recipient: the value is whatever the notes already
  held. Fragmentation matters because a spend can only reach as much as its
  own input cap allows, so a balance spread over many small notes is not
  fully spendable in one operation until it is consolidated.
  - **Why 5 and not 8.** The circuit pads to eight inputs
    (`MERGE_INPUT_COUNT`), but the deployed prover refuses more than five, so
    SDP selects its own inputs (`MERGE_MAX_INPUTS`) rather than letting the
    SDK's auto-selector reach for eight and fail at proving. Selection is
    smallest-first — the opposite of a spend, because the point is to retire
    the dust that a spend's change keeps producing.
  - **Merging is gated on chain, and SDP clears the gate.** The owner's
    user-registry record carries a `mergingEnabled` flag, and
    `buildRegistrationTransaction` cannot set it, so a freshly registered record
    refuses merges with `WALLET_MERGE_DISABLED`. Turning it on is its own
    custody-signed transaction. Provisioning sends it, so new wallets can merge
    immediately; the merge path also reads the record first and sends it if
    needed, so wallets registered before merge shipped heal on their next merge
    instead of needing a migration. There is no SDP toggle for it: a merge moves
    no value and reveals no amount, so the flag is a protocol precondition
    rather than a policy decision.
  - **Default ring only, for want of a builder.** The program implements a ring
    merge — `InstructionTag.ringMergeTransact` is 16, beside the default ring's
    `mergeTransact` at 13 — but 0.1.6-alpha exposes no builder for it: the tag
    appears only in the tag table, the ring builders all move value (deposit,
    entry, exit, transfer, withdrawal), and `buildMergeTransaction` takes no
    `ringProgramId`. So the merge route accepts no `ring` and the SDK refuses a
    ring-pinned merge. Sync still reports ring positions with their own
    `noteCount`, so ring fragmentation is visible but not yet actionable.
    Unblocking it is a Helius SDK ask, not program work.
    A ring transfer to the wallet's own shielded address would consolidate, but
    it is not the same operation: every ring transfer carries an auditor
    message, so it would reach the ring's audit as a self-transfer, and it
    verifies two proofs at 1.4M CU rather than the merge circuit.
  - **What the wire policy can prove.** Less than for a spend, and by nature: a
    merge publishes no amount and no recipient, so there is no public effect to
    bind an approved figure to. Custody instead proves the bytes are a merge
    (tag 13, the protocol's fixed-width 8-in/1-out layout), for this owner,
    against this owner's locally derived user-registry record, on the expected
    tree, with no other account reachable. Conservation of value is the
    circuit's job, not custody's.

Follow-up work, deliberately out of scope: cross-ring transfers (impossible
in one transaction at the protocol level — value routes through the default
ring in two hops; ring ↔ default moves ship as `ring_exit`/`ring_entry`, so
the follow-up is server-side orchestration of the two moves, which the Move
tab's From/To pair already expresses), USDC ring moves (a move settles
shielded, so nothing about its wire resists USDC, but `requireProtocolSol`
and the wire gate hold both arms to SOL until one has been proved against the
pool's SPL interface), audit reads and grants to further readers (bring-up's
initial grant makes the custody-held config authority the ring's only reader,
so serving decrypted reads or granting a third-party reader needs a future
custody-signed endpoint), and `GET /rings/:name` point reads.

## Diagnostics

- `GET /v1/helius-rings/health` — component probes in `helius_rings_runtime_health`.
- Dashboard — health board, balances with per-position note counts, composer
  (shield, withdraw, private transfer, merge, move), and Activity
  with each row's action inline: execute, retry, or recheck and void for
  `manual_reconciliation_required`.
