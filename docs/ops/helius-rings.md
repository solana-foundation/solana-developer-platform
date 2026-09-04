# Helius Rings — operations reference

Devnet-only shielded wallets bound to SDP custody. Shield (deposit) and withdraw
(SOL spend) are built; transfer and merge are not.

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

| Variable | Meaning |
| --- | --- |
| `HELIUS_RINGS_ENABLED` | Gates routes, dashboard, indexing poll. Default `false`. |
| `HELIUS_RINGS_RPC_URL` | Solana RPC (API key in URL). Required when enabled. |
| `HELIUS_RINGS_INDEXER_URL` | Photon indexer. Required when enabled. |
| `HELIUS_RINGS_PROVER_URL` | Proving service. Required when enabled. |
| `HELIUS_RINGS_RING_RPC_URL` | Helius ring RPC that mints custom-ring auditor keys. Optional: absent, recording a custom ring fails `config_error` while everything else keeps working. |
| `HELIUS_RINGS_ALLOW_INSECURE_HTTP` | Opt-in plain HTTP for devnet upstreams. |
| `SOLANA_NETWORK` | Must be `devnet`. |

> **The seed is public.** Identities derive from `INSECURE_TEST_SEED_DEVNET_ONLY!!`
> in `packages/sdp-helius-rings-sdk/src/deterministic-ka/seed.ts`. Devnet only.

Missing upstreams → health red, port methods fail with `config_error` (not a throw at
construction).

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

## SPL follow-up

This PR is SOL-only. SPL withdraw is reachable: `WithdrawalTarget.spl` and
`getSplAssetVaultAddress(mint)` are exported; re-derive the vault PDA with seeds
`["spl_asset_vault", mint]` and assert it equals the exported address to recover
the bump. SPL also needs an idempotent create-ATA instruction.

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
| Shield (custom ring) | same; also needs `HELIUS_RINGS_RING_RPC_URL` and an active ring | Ring-bound deposit through the ring program |
| Withdraw (SOL) | same | Note selection, prove, outbox, sign, broadcast, index |
| Withdraw / transfer (custom ring, SOL) | same; needs the ring active with its lookup table | Ring transact through the SDK's one-call builders, ALT-compressed |
| Merge | not exposed | not exposed |

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

SDP then completes bring-up through the SDK: an auditor key from the ring RPC
(`HELIUS_RINGS_RING_RPC_URL`), the ring's create-config instruction, its
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
- **Ring spends have no pinned-input contract.** The SDK's one-call ring
  builders select same-ring notes internally on every build, so `input_notes`
  persists empty and a pre-sign rebuild may spend different notes than the
  failed attempt (default-ring spends keep their deterministic
  pinned-notes rebuild). Duplicate payment stays gated by the signed-bytes
  line: once bytes are signed, recovery only ever resends them.
- **What custody's wire gate can and cannot prove on a ring spend.** It proves
  the right ring program, the right tree, the ring's pinned lookup table, the
  exact account universe, a single owner signature, and the public settlement
  (none on a transfer; exactly the approved recipient and amount on a
  withdraw). On a ring TRANSFER the recipient and amount live inside encrypted
  outputs and cannot be re-derived from the wire — the pre-encryption
  prepared-intent check that binds them on default spends is bypassed because
  the one-call builders never expose the prepared transfer. Accepted because
  the transaction is built in-process against the approved persisted intent
  and the recipient is a same-tenant wallet's shielded address.
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
  can move.
- **Auditor key.** Held by the Helius ring RPC, never by SDP; the config's
  public half is recorded on the ring row and echoed by `GET /rings`.

Follow-up work, deliberately out of scope: ring → default-ring exits (the SDK
exposes only a low-level `sendDefaultRing`), cross-ring transfers (impossible
in one transaction at the protocol level — value routes through the default
ring in two hops), SPL ring spends (the withdrawal builder is SOL-only in
0.1.2-alpha), audit reads and grants to further readers (bring-up's initial
grant makes the custody-held config authority the ring's only reader, so
serving decrypted reads or granting a third-party reader needs a future
custody-signed endpoint), and `GET /rings/:name` point reads.

## Diagnostics

- `GET /v1/helius-rings/health` — component probes in `helius_rings_runtime_health`.
- Dashboard — health board, balances, composer (shield + withdraw), and Activity
  with each row's action inline: execute, retry, or recheck and void for
  `manual_reconciliation_required`.
