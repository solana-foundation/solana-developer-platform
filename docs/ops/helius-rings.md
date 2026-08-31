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
| `manual_reconciliation_required` | no | Signed bytes exist; fate unknown. Operator must reconcile or void. |
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

### Manual void

When indexing times out on a row with signed bytes, the sweep classifies
`manual_reconciliation_required` (non-retryable). The operator checks the chain:

- **Landed** — resubmit same bytes or wait for Photon; do not void.
- **Never landed** — `POST /operations/:id/void` with `{ signature }` matching
  `outer_tx_signature`. CAS `failed → voided`, releases the spend slot.

No automatic reconcile job in this build.

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
- `POST /operations/:id/execute` has no trusted body.

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
   check, then `manual_reconciliation_required` (non-retryable). Skipped when
   the chain height is unavailable.
2. **Indexed failures** — a signed failure Photon now holds is completed. Never
   the reverse: absence from the indexer never voids anything.
3. **In-flight** — advance `submitted` → poll (crash recovery) and poll
   `indexing` via `verifyIndexed`. A crashed `proving` rebuilds; a
   `ready_to_sign` resends its bytes, or fails `signer_failed` (retryable) if it
   has none. Stale `indexing` then times out: unsigned → `indexing_timeout`
   (retryable); signed → `manual_reconciliation_required` (non-retryable).

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
| Transfer / merge | not exposed | not exposed |

## Custom rings

One custom ring per project. A custom ring is its own on-chain program;
deposits into it are ring-bound, so only that ring's own instructions can ever
spend the notes, and every ring transfer carries a message the ring's auditor
key can decrypt. Ring membership is a property of each note, not of a wallet:
one private wallet holds default-pool notes and ring-bound notes side by side,
and each operation names the ring it targets. SDP operates a ring but does not
deploy its program — the TypeScript SDK has no program-deploy capability.

### Ops runbook: deploying a project's ring program

1. Get the `zolana-ring` CLI from the `custom-rings` release of
   [`helius-labs/zolana`](https://github.com/helius-labs/zolana). (The old
   `zolana-ring` cargo-generate template repo is archived; the CLI replaced
   it.) `zolana-ring new` writes the ring's `ring.toml` and program keypair —
   each project gets a distinct program id.
2. Deploy to devnet with `zolana-ring deploy`, with the upgrade authority set
   to one of the project's active custody wallets. The CLI downloads its
   release's ring program binary, checks it against the lockfile built into
   the CLI, and after deploying reads the account back and refuses to report
   success unless the bytes on chain hash to the file it deployed. Bring-up
   signs as the upgrade authority through custody, so a program whose
   authority custody does not hold cannot be brought up. Fund that custody
   wallet with devnet SOL first: it fee-pays every bring-up transaction and
   rents the config, ring-auth, and reader-record accounts.
3. Hand the program id to the project admin. They enter it in the dashboard's
   *Custom ring* card (or `POST /v1/helius-rings/ring`).

SDP then completes bring-up through the SDK: an auditor key from the ring RPC
(`HELIUS_RINGS_RING_RPC_URL`), the ring's create-config instruction, its
shielded-pool registration, and a read grant naming the config authority as
the ring's initial reader, each signed through custody and confirmed on chain.
The recorded ring row moves `pending → active`, with any failure recorded on
the row.

### Semantics worth knowing

- **Shield-only, per-operation selection.** A shield names its ring
  (`ring: "default" | "custom"`, default `"default"`); withdraw and private
  transfer accept no ring and always spend default-pool notes — ring-bound
  notes are excluded from their note selection outright. Default-ring
  operations and sync are never blocked by the custom ring's state.
  `ring: "custom"` is a `400` while no ring row exists and a `503`
  (`config_error`) until bring-up completes; the resolved program id is pinned
  on the operation row at prepare time and never re-resolved, so an approval
  granted days later — and any retry — runs against the ring the reviewer saw.
  The pinned ring also joins the intent key: the same shield aimed at a
  different ring is a second operation, not a replay.
- **Resume, never re-key.** Bring-up is idempotent against on-chain state:
  re-submitting the same program id resumes from whatever already landed
  (config present, pool registration missing, and so on). An existing on-chain
  config is adopted as it stands — re-keying a live ring would orphan its
  auditor. Adopting a fully-registered ring lands no transaction, so custody
  first proves it holds the config authority by signing a challenge; a ring
  administered by someone else's key is refused with a `409`.
- **No re-pointing once active.** Submitting a different program id replaces a
  ring that never went active (a mistyped id binds no notes, so correcting it
  strands nothing) and is a `409` once the ring is active. Moving a project off
  a live ring would strand every ring-bound note; that is a deliberate
  migration, not a config flip.
- **Balances are tagged per ring.** Sync returns every unspent note the wallet
  holds, grouped by `ringProgramId` (`null` = the default public pool). The
  groups never merge into one number: value cannot cross a ring boundary
  inside a spend, so a merged figure would overstate what any single operation
  can move.
- **Auditor key.** Held by the Helius ring RPC, never by SDP; the config's
  public half is recorded on the ring row and echoed by `GET /ring`.

Ring-bound withdrawals and transfers, audit reads, and grants to further
readers are follow-up work: spending a ring-bound note needs the ring's own
transact instruction, which nothing here emits yet. Bring-up's initial grant
makes the custody-held config authority the ring's only reader, so serving
decrypted reads (or granting a third-party reader, which only the authority
can sign) needs a future custody-signed endpoint.

## Diagnostics

- `GET /v1/helius-rings/health` — component probes in `helius_rings_runtime_health`.
- Dashboard — health board, balances, composer (shield + withdraw), recovery card
  (execute, retry, void for `manual_reconciliation_required`).
