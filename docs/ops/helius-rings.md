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
| Withdraw (SOL) | same | Note selection, prove, outbox, sign, broadcast, index |
| Transfer / merge | not exposed | not exposed |

## Diagnostics

- `GET /v1/helius-rings/health` — component probes in `helius_rings_runtime_health`.
- Dashboard — health board, balances, composer (shield + withdraw), recovery card
  (execute, retry, void for `manual_reconciliation_required`).
