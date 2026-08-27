# Helius Rings — operations reference

Helius Rings is SDP's devnet-only shielded-wallet module: private wallets bound
to SDP custody wallets, with shielded transfers built on Zolana. This document
covers the architecture an operator needs: the state machine, failure codes,
configuration, and which money flows are built. Shield — the public-to-private
deposit — is the one that is. Transfer, withdraw and merge are not.

Behind the port sits `@sdp/helius-rings-sdk`, running in the API process. That
is the only implementation — there is no adapter switch and no sidecar.

## Architecture

```
routes (/v1/helius-rings)               flag-gated, real policy enforcement
  └─ HeliusRingsService                 devnet guard, intent reservation,
       │                                prepare-through-policy, retry lineage
       ├─ repositories (Postgres)       wallets, operations+timelocks,
       │                                key refs, zones, events, health
       ├─ signer adapter                custody signer resolved from the
       │                                identity's owner public key
       ├─ RPC adapter                   shared sendTransaction path
       └─ RingsGatewayPort              THE seam. @sdp/helius-rings-sdk runs
                                        behind it, in this process.
```

`RingsGatewayPort` is the only place external Rings infrastructure (Solana RPC,
Photon indexer, prover, key authority) is called. Everything on the SDP side of
the port is real and fully tested. Behind it, `@sdp/helius-rings-sdk` — the
Zolana SDK in this process — answers health probes, identity provisioning,
shielded balance reads, and shield deposits. Transfer, withdraw and merge still
throw `gateway_unavailable`. There is no adapter selector and no HTTP sidecar:
the SDK is the implementation. Until an operator sets the four upstream
variables the port answers with a reporter that names what is missing, and no
mock ships at all.

A shield is the cheapest money flow to build and the cheapest to reason about:
it creates a note rather than spending one, so there is no proof to request, no
wallet sync, and no note selection. The owner's Ed25519 signature on the outer
transaction is the whole of the authorization, exactly as it is for
registration. Everything harder is still ahead.

## Configuration

| Variable | Values | Meaning |
| --- | --- | --- |
| `HELIUS_RINGS_ENABLED` | `false` (default) / `true` | Gates the API routes, the dashboard workspace, and the indexing-poll job. |
| `HELIUS_RINGS_RPC_URL` | URL | Helius Solana RPC the Rings SDK reads and submits through, API key already applied. Required once Rings is enabled. |
| `HELIUS_RINGS_INDEXER_URL` | URL | Photon indexer. Required once Rings is enabled. |
| `HELIUS_RINGS_PROVER_URL` | URL | Proving service. Required once Rings is enabled. |
| `HELIUS_RINGS_ALLOW_INSECURE_HTTP` | `false` (default) / `true` | Permits plain-http upstreams. The public devnet indexer and prover are http on a real host, and the SDK refuses to dial them without this. In plaintext an indexer response reveals which notes an identity owns, so it is opt-in per environment rather than inferred from the URL. |
| `SOLANA_NETWORK` | must be `devnet` | `HeliusRingsService` refuses to construct on any other network, and the schema pins `helius_rings_wallets.network` to `'devnet'`. Going to mainnet is a deliberate forward migration, not a config flip. |

> **The seed is public.** Shielded identities are derived from
> `INSECURE_TEST_SEED_DEVNET_ONLY!!`, hardcoded in
> `packages/sdp-helius-rings-sdk/src/deterministic-ka/seed.ts`. Anyone with the
> source derives the same keys, so a shielded balance here is not private. The
> API logs a warning on first derivation, and this is why `SOLANA_NETWORK` must
> be `devnet`.

Enabling Rings without all three upstream values does not throw at construction.
The health board reports every component red naming the missing variables, and
every other gateway method fails with `config_error`. Throwing would 500 the
health endpoint an operator reaches for first.

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
| `signer_failed` | ready_to_sign | varies | Custody signing failed; `WALLET_NOT_FOUND`-class errors are non-retryable. Also how the sweep ages out an operation abandoned before its signature was recorded (`RINGS_SIGNING_TIMEOUT_MS`, 10 minutes) — nothing was broadcast in that window, so retrying is safe. |
| `submit_failed` | submitted | yes | Raised by the RPC adapter, and taken only by provisioning, which re-reads the user record and so cannot register twice. The operation pipeline does **not** fail on it: see "Broadcast ambiguity". |
| `indexing_timeout` | indexing | yes | Photon did not index within 30 minutes (`RINGS_INDEXING_TIMEOUT_MS`). |
| `gateway_unavailable` | any port call | yes | The gateway seam is unreachable, unconfigured, or asked for a flow that is not built (transfer, withdraw, merge). |
| `invalid_input` | preparing | varies | Policy evaluation threw, or an inconsistent row was found. |

### Broadcast ambiguity

An RPC that throws on submit has not told you the transaction failed. It can
time out or 503 after the node accepted it, and since only the signature is
persisted — never the signed bytes — nothing available afterwards separates
"never left" from "landed, and we lost the acknowledgement".

Failing the operation there would be the dangerous reading. `submit_failed` is
retryable, a retry files a fresh operation under a new client nonce, and a new
nonce means a new intent key, a newly built transaction and a second broadcast.
Whenever the first one did land, that shields the amount twice. **The intent key
does not protect this**: it deduplicates a replayed identical request, which is
not the same property as making a resubmission safe.

So the pipeline does not take the failure. It carries the signature into
`indexing` and lets Photon adjudicate, which is exactly how the identical
ambiguity after a process crash was already handled. A transaction that truly
never left is indexed by nobody and ends at `indexing_timeout` — retryable, but
only after Photon has had the full 30 minutes to disagree. The operation's
`transaction.submitted` event records `broadcast: "unconfirmed"` so the timeline
says which reading applied.

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
- Key material is not persisted by the service, and there is nothing to seal
  into `helius_rings_key_refs`: the deterministic key authority recomputes
  every identity from the hardcoded seed on demand and stores none of it.
  Provisioning reports only which kind of material it used. Not storing the
  keys is not the same as their being secret — see the warning above.
- Provisioning signs the registry's `register` instruction and nothing else.
  The record is read first to decide whether to build at all, and the built
  transaction is then decoded before custody sees it — one instruction, the
  user registry, discriminator `0` — because the SDK's builder reads the record
  again for itself and switches to `update_keys` without saying so if one
  appeared in between. `update_keys` re-keys a published identity on the
  owner's Ed25519 signature alone; SDP refuses it, because taking it would
  orphan every note encrypted to the old keys. Either guard refusing is a
  `409` naming the owner.

## Identity rotation

**SDP does not offer it, and this is settled rather than pending.**

Re-keying is permitted on chain: `update_keys` accepts the owner's Ed25519
signature alone, with no proof that the incoming keys can read anything the
outgoing ones could. What an operator would need before taking it is the safety
check — *does the old identity still hold notes?* — and that check cannot be
built. Reading those notes requires the old viewing **secret**. SDP never held
it for a record registered by someone else, and once the derivation seed or
path has changed it cannot reconstruct the one it did derive. A rotation would
therefore always be a blind write, and the
blindness is the whole risk: whatever the old identity still holds becomes
unspendable at the moment it succeeds.

So an owner whose address is already registered to keys SDP cannot derive is
resolved by **binding a different custody wallet** to the private wallet. That
address is spent for Rings — SDP will not take it back — and the operator pays
one wallet, not an unrecoverable balance. Provisioning surfaces the conflict as
a `409` naming the owner, which is the signal to bind elsewhere.

## Background jobs

`poll-rings-indexing` runs every minute in-process (`cron/runner.ts`) and once
per managed-job execution every five minutes (`src/job.ts`, the only tick a
Cloud Run deployment gets — web replicas skip the in-process scheduler under
`K_SERVICE`). Registered unconditionally in both, inert unless
`HELIUS_RINGS_ENABLED=true` **and** every upstream variable is set. The second
half is not redundant: the sweep catches per operation, so an enabled but
half-configured deployment would otherwise log one warning per in-flight
operation every minute.

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
4. Operations stuck in `ready_to_sign` past 10 minutes fail as `signer_failed`
   (retryable). This one reconciles nothing, because there is nothing to
   reconcile: the pipeline broadcasts only after the transition out of
   `ready_to_sign` commits, so an operation that died in that window never
   reached an RPC. The row is stale state rather than a lost payment, which is
   what makes failing it outright safe and retrying it free of duplication
   risk. The budget is short because the window covers one custody signature
   and a decode, not a wait on anyone else.

## Diagnostics

- `GET /v1/helius-rings/health` probes the gateway and records one row per
  component (`rpc`, `prover`, `photon`, `gateway`) in
  `helius_rings_runtime_health`. A component that has never been observed
  reads **red**, not green.
- The dashboard workspace (`/dashboard/helius-rings`) renders the health
  board, wallets with their shielded balance in the table, composers, activity,
  the operation detail timeline, and the recovery card. Degraded states render
  honestly: a wallet whose provisioning was refused stays `pending` and shows
  the server's reason; a partial indexer read is labelled partial rather than
  presented as the balance; a holding whose mint the gateway cannot label
  reports no scale at all, and its amount renders as an exact base-unit count
  labelled as one rather than at a guessed scale; failed operations show their
  code verbatim.

## What stays dark

| Surface | Upstreams unset | Upstreams configured |
| --- | --- | --- |
| Wallet provisioning | `503` naming the unset variables; wallet stays `pending`. | Registers the identity on chain; the wallet becomes `ready`. |
| Balances / Photon sync | `503`; no cursor ever advances. | Read on demand from the workspace's refresh action, never on a timer. |
| Health board | Every component red, each naming the unset variables. | One probe per upstream; `gateway` green, because the SDK runs in this process. |
| Shield | `failed:gateway_unavailable` (retryable). | Builds, signs through custody, broadcasts, and completes once Photon indexes it. |
| Transfer / withdraw / merge | `failed:gateway_unavailable` (retryable). | `failed:gateway_unavailable` (retryable). |

The last row is the one that does not move. `buildOperation` refuses any
`opType` but `shield`, so those three flows fail identically whether or not the
upstreams are configured, and the dashboard composer offers only `shield` rather
than presenting choices that cannot complete.

Every window a crash can land in is now swept. `submitted` was the dangerous
one, because the broadcast happens inside it and a crash there could strand a
live transaction: the sweep picks those rows up and `executeOperation` treats
`submitted` as executable, so a stranded broadcast either completes on a Photon
hit or fails retryably at the indexing budget. `ready_to_sign` is the harmless
one — nothing has been broadcast yet — and it ages out at its own shorter budget
rather than waiting for someone to notice it.
