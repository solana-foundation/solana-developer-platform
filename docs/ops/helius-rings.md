# Helius Rings — operations reference

Helius Rings is SDP's devnet-only shielded-wallet module: private wallets bound
to SDP custody wallets, with shielded transfers built on Zolana. This document
covers the architecture an operator needs: the state machine, failure codes,
configuration, and the seams that stay dark until the external integration
(Track B) lands.

## Architecture

```
routes (/v1/helius-rings)               flag-gated, real policy enforcement
  └─ HeliusRingsService                 devnet guard, intent reservation,
       │                                prepare-through-policy, retry lineage
       ├─ repositories (Postgres)       wallets, operations+timelocks,
       │                                key refs, zones, events, health
       ├─ signer adapter                createOrgSigner → custody signing
       ├─ RPC adapter                   shared sendTransaction path
       └─ RingsGatewayPort              THE seam. Production wiring is
                                        NotImplementedRingsGateway until the
                                        live HTTP adapter replaces it.
```

`RingsGatewayPort` is the only place external Rings infrastructure (Zolana
sidecar, Photon indexer, prover, key authority) is called. Everything on the
SDP side of the port is real and fully tested; everything behind it throws
`gateway_unavailable` until Track B wires the live adapter. No mocks ship: the
test double lives behind the `@sdp/helius-rings/testing` subpath and is not
selectable in production.

## Configuration

| Variable | Values | Meaning |
| --- | --- | --- |
| `HELIUS_RINGS_ENABLED` | `false` (default) / `true` | Gates the API routes, the dashboard workspace, and the indexing-poll job. |
| `HELIUS_RINGS_ADAPTER` | `none` (default) / `http` | Gateway selector. Only `http` activates the live adapter and the indexing poll; anything else keeps `NotImplementedRingsGateway`. |
| `SOLANA_NETWORK` | must be `devnet` | `HeliusRingsService` refuses to construct on any other network, and the schema pins `helius_rings_wallets.network` to `'devnet'`. Going to mainnet is a deliberate forward migration, not a config flip. |

## State machine

```
draft → preparing → approval_required → proving → ready_to_sign
      → submitted → indexing → completed
```

Every non-terminal state has one typed fail edge; `failed` rows always carry
`failure_code`, `failure_message`, and `retryable` together (DB CHECK). All
transitions run compare-and-swap under `SELECT … FOR UPDATE`, so two workers
cannot advance the same operation twice.

States an operator will actually observe at rest: `approval_required`
(waiting on a reviewer), `indexing` (waiting on Photon), `completed`, and
`failed`. The remaining states are transient — the prepare pipeline drives
through them in one pass.

## Failure codes

| Code | Fails from | Retryable | Meaning |
| --- | --- | --- | --- |
| `policy_denied` | preparing | no | Wallet/API-key policy denied the operation. |
| `approval_rejected` | approval_required | no | The approval request was rejected, canceled, or expired. |
| `proof_failed` | proving | yes | Prover returned an error. |
| `signer_failed` | ready_to_sign | varies | Custody signing failed; `WALLET_NOT_FOUND`-class errors are non-retryable. |
| `submit_failed` | submitted | yes | RPC broadcast failed; the intent key makes resubmission safe. |
| `indexing_timeout` | indexing | yes | Photon did not index within 30 minutes (`RINGS_INDEXING_TIMEOUT_MS`). |
| `gateway_unavailable` | any port call | yes | The gateway seam is not implemented or unreachable. The expected failure until Track B lands. |
| `invalid_input` | preparing | varies | Policy evaluation threw, or an inconsistent row was found. |

## Idempotency and retries

- `intent_key = sha256(walletId, opType, canonical(input), clientNonce)` with a
  unique index. A replayed prepare returns the operation already reserved —
  never a duplicate.
- A retry files a **new** operation with a new client nonce, linked via
  `retry_of_operation_id`, and re-runs the full policy path — a retry re-earns
  its verdict, never inherits one. Chains are capped at 5; the original failed
  row is never mutated (lineage is audit evidence).
- Approval verdicts are read from the stored approval request server-side.
  `POST /operations/:id/execute` carries no trusted body.

## Secret handling

- Viewing keys, nullifier keys, and proof internals travel as `SecretRef<T>`
  (`toJSON`/`toString` → `"[REDACTED]"`). `scripts/check-secretref-serialization.mjs`
  fails CI when a `reveal()` result — direct or via alias — reaches a logger,
  `JSON.stringify`, `String()`, or a template literal.
- The pino redaction registry (`apps/sdp-api/src/runtime/log-redaction.ts`)
  censors `viewingKey`, `nullifierKey`, `ringsMetadata`, `proof.ref`,
  `proof.internal`, and `keyRefs[*].material`.
- Event payloads are redacted at write time (arbitrary depth), so the timeline
  table cannot accumulate secret material.
- Key material is not persisted by the service. Sealed storage through
  custody-cipher into `helius_rings_key_refs` is the key-authority work
  (Track B4).

## Background jobs

`poll-rings-indexing` runs every minute in-process (`cron/runner.ts`) and once
per managed-job execution every five minutes (`src/job.ts`, the only tick a
Cloud Run deployment gets — web replicas skip the in-process scheduler under
`K_SERVICE`). Registered unconditionally in both, inert unless
`HELIUS_RINGS_ENABLED=true` and `HELIUS_RINGS_ADAPTER=http`:

1. Operations in `submitted` are advanced to `indexing` and polled in the same
   call. This is the crash-recovery path: the broadcast happens inside
   `submitted`, so a process that dies before the indexing transition commits
   leaves a live transaction there. The signed bytes are not persisted, so
   there is nothing to resubmit — the signature is handed to Photon and the
   indexing budget settles it either way.
2. Operations in `indexing` poll `verifyIndexed` through the port; a hit
   completes them.
3. Operations stuck in `indexing` past 30 minutes fail as `indexing_timeout`
   (retryable). The budget is not applied to a resumed `submitted` row: it
   measures how long Photon has been asked, and that row has not been asked
   yet.

## Diagnostics

- `GET /v1/helius-rings/health` probes the gateway and records one row per
  component (`rpc`, `prover`, `photon`, `gateway`) in
  `helius_rings_runtime_health`. A component that has never been observed
  reads **red**, not green.
- The dashboard workspace (`/dashboard/helius-rings`) renders the health
  board, wallets, composers, activity, the operation detail timeline, and the
  recovery card. Degraded states render honestly: a wallet whose provisioning
  hit the seam stays `pending`; failed operations show their code verbatim.

## What stays dark until Track B

| Surface | Behavior today |
| --- | --- |
| Wallet provisioning | `503` seam response; wallet stays `pending`. |
| Any operation past policy | `failed:gateway_unavailable` (retryable). |
| Balances / Photon sync | Not rendered; no fake cursor ever advances. |
| Health board | `gateway` red; unobserved components red. |

Track B replaces `NotImplementedRingsGateway` with the live HTTP adapter one
method at a time (health first), flipping `HELIUS_RINGS_ADAPTER=http` when the
sidecar is reachable.

One gap remains in `runPipeline` for the moment that flip happens: **nothing
sweeps `ready_to_sign`.** An operation that dies between the proof landing and
the signature being persisted needs a human. Nothing was broadcast in that
window, so there is no on-chain effect to reconcile — the row is stale state,
not a lost transaction.

`submitted` is covered. The broadcast happens inside `submitted`, so that was
the one window where a crash could strand a live transaction; the sweep now
picks those rows up and `executeOperation` treats `submitted` as executable, so
a stranded broadcast either completes on a Photon hit or fails retryably at the
indexing budget.
