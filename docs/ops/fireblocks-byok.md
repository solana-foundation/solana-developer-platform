# Fireblocks BYOK

Fireblocks **BYOK is in beta**. Its shared maturity entry publishes BYOK setup, signing,
OpenAPI, the playground and the customer guide on beta and experimental channels; a stable
deployment does not offer it yet.
Managed Fireblocks custody remains beta, and Earn retains its own beta gate.
Organization entitlement (`providerOverrides`) is still required: beta publication does not
make Fireblocks the default provider or enable it for every organization. Release
channel and Solana network are independent; a beta deployment can use devnet or mainnet.

Fireblocks connections use the same project-scoped encrypted credential lifecycle as Privy:
installation, credential checks, replacement, rotation, rollback, deactivation, and secret
retirement. Organization entitlement to Fireblocks is still required. Deploy the Fireblocks migrations `0160`–`0163` before the API. They extend
the GCP reservation and cleanup constraints, enforce one unfinished Fireblocks installation,
and add tenant-isolated, encrypted CSR registration storage.

If a local development database already applied Fireblocks migrations from an earlier
PR revision, record their new filenames before running migrations. Their SQL is unchanged;
`main` now uses the earlier numbers for other features. This prevents replaying the CSR
table creation or constraint changes after their validation migration already ran:

```sql
UPDATE schema_migrations
SET version = '0161_fireblocks_byok.sql'
WHERE version = '0152_fireblocks_byok.sql'
  AND NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '0161_fireblocks_byok.sql'
  );

WITH renames(old_version, new_version) AS (VALUES
  ('0153_fireblocks_csr_requests.sql', '0160_fireblocks_csr_requests.sql'),
  ('0154_fireblocks_byok.sql', '0161_fireblocks_byok.sql'),
  ('0156_fireblocks_unfinished_index.sql', '0162_fireblocks_unfinished_index.sql'),
  ('0157_fireblocks_credential_checks.sql', '0163_fireblocks_credential_checks.sql')
)
UPDATE schema_migrations AS applied
SET version = renames.new_version
FROM renames
WHERE applied.version = renames.old_version
  AND NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = renames.new_version
  );
```

If a development database already applied an earlier PR version of the CSR migration without
the status column, apply this compatibility update before starting the new API.
Preserve the database and payment receipts used for mainnet testing.

```sql
ALTER TABLE fireblocks_csr_requests
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived'));
UPDATE fireblocks_csr_requests SET status = 'archived'
  WHERE encrypted_private_key IS NULL;
```

## Connect a workspace

In the dashboard, choose **Generate and download CSR**. SDP generates a dedicated RSA-4096
key on the server for this organization, project, and registration attempt; only the public
PKCS#10 CSR is returned. No signing key or CSR is shared across customer organizations.
The dashboard presents this registration walkthrough inline:

1. In Fireblocks Console, open **Developer Center → API Users → Add API user**.
2. Name the API user **SDP** and choose **Editor**. Keep the customer's designated signer in
   the transaction policy. A new API Co-signer is not required for this integration.
3. Upload the downloaded CSR, select **Add user**, and complete the workspace's required
   approvals. Wait for the API user to become active.
4. Copy **API User (ID)** (also called the API key) into SDP and choose **Load vaults**.
5. Select the vaults to connect by name, then choose **Connect and verify**. SDP imports each
   selected Solana wallet and defaults its label to the Fireblocks vault name. Users can rename
   these wallets afterward. No manual vault-ID entry is needed.

Never import a customer's private key. This follows Fireblocks' [third-party integration
guidance](https://developers.fireblocks.com/docs/integrate-fireblocks-with-third-party-service-providers).

Discovery uses the project's generated signing key and API user ID to call the real
`GET /v1/vault/accounts_paged` endpoint, filtered to the project's Solana asset, with explicit
50-vault pagination. It returns only IDs, names, and Solana availability. It does not consume
the CSR or persist the API user ID. Only configured server endpoints are contacted; provider
pagination URLs are never followed. Up to 20 vaults can be selected per connection. Completion
re-reads their names, verifies every address through solana-keychain, and imports the entire
selection atomically under one credential. Vaults already connected in the project are refused.

The API accepts only a generated signing-key reference, API user ID, and selected vault IDs. Generation
is authenticated, entitlement-gated, rate-limited, audited, and idempotent. Registrations are
bound to their organization and project, expire after seven days, and can be resumed after a
reload. The private key is encrypted using the custody cipher (KMS in managed deployments;
local AES for self-hosted deployments). It moves into the existing credential secret lifecycle
on submission; the staging copy is erased after durable storage. The secret-retirement worker
erases expired staging copies in bounded batches. Responses expose only public CSR data and,
for stored credentials, the API user ID suffix. Rotations generate a new key and CSR.

The project environment selects the asset: `SOL_TEST` for sandbox and `SOL` for production.
The encrypted credential pins that choice. The API endpoint comes only from the deployment's
`FIREBLOCKS_API_BASE_URL`; credential submissions cannot override either the endpoint or asset.
The endpoint must serve the workspace owning the API user.

Verification reads each vault address using `FireblocksSigner` from
`@solana/keychain-fireblocks` and attaches those existing wallets. It does not create a vault,
propose a transaction, or transfer funds. Later wallet creation uses the same connection's
credentials to create another vault and Solana asset wallet.

Rotation and rollback verify the pinned primary vault, network, and every attached wallet's
Solana address, including inactive wallets. Each distinct vault is read once through
solana-keychain using the replacement credential. Missing permissions or changed addresses
leave the current credential in place; temporary provider failures remain retryable. Before
committing, SDP locks and rechecks the wallet set so a concurrent import or address change
cannot bypass verification. API user keys may change, but a credential cannot silently
redirect the connection to another vault or workspace. Each signing request also checks the
requested wallet's ownership and signer address. Deactivation in SDP does not revoke the
API user in Fireblocks.

## Transaction approval

Direct SOL and USDC payments through `POST /v1/payments/transfers` use Fireblocks'
[TRANSFER operation](https://developers.fireblocks.com/api-reference/transactions/create-a-new-transaction).
SDP resolves the exact project wallet and its encrypted BYOK credential. Fireblocks builds the
transaction, applies the workspace's approvals, signs and broadcasts. The source vault needs
SOL for fees (also when sending USDC); SDP's local/Kora fee sponsor is not involved.
No RAW-signing permission or SDP Signer check is required for these payments.

USDC is resolved by its exact Solana mint (`issuerAddress`) and `nativeAsset` in Fireblocks'
asset catalogue, never by symbol alone. The Pay token picker offers only native SOL and the
current network's canonical USDC mint for Fireblocks BYOK. Other tokens and ramp-deposit
reuse are rejected by this direct-payment path. Managed Fireblocks wallets retain their existing sponsored
signing path. Batch and custom-program signing use sign-only PROGRAM_CALL through solana-keychain;
they have not been converted to native transfers.

SDP sends the exact selected address using `ONE_TIME_ADDRESS`. Fireblocks resolves matching
whitelisted destinations in its workspace; unmatched destinations require one-time transfers
to be allowed by the workspace. The read-only SDP checks do not change the submitted address.
An SDP contact alone does not whitelist an address. Manage whitelisting in Fireblocks. The SDP memo becomes a Fireblocks note, not a Solana memo instruction.

Before submission, SDP durably stores the intent and atomically claims a single create attempt.
The SDP transfer ID is Fireblocks' permanent `externalTxId`; transaction creation does not
send Fireblocks' time-limited `Idempotency-Key` header. SDP separately deduplicates the caller's
request using its own idempotency key.

New direct transfers also record `initiated_by_principal` from the authenticated
money context before proposing. It uses the canonical `MoneyPrincipal` identity
(for example, `{kind: "member", userId: "..."}`), without role or grant snapshots.
The field is internal and stays unchanged on retries, status reads and settlement;
`initiated_by_key_id` remains separate audit evidence. Migration `0226` leaves
historical rows null and accepts writes from the previous API revision. Never
reconstruct their authority from the ambiguous audit ID. Worker restoration and
D4 re-admission/cancellation follow this persistence slice of PRO-2435; neither
is enabled by this change.

The payment's critical audit intent stays open while the proposal awaits approval. The read or
cron run that settles the payment (confirmed, failed, rejected or expired) closes it with
Fireblocks' outcome in the same transaction as the status change, as the pending-transfer job
does for a signed payment; acceptance alone is never audited as success.

The payment goes through the same custody waist as every signed payment (ADR 0007). The
waist resolves a Fireblocks BYOK wallet to a proposer rather than a signer
(`services/domain/signing/admitted-proposer.ts`), with the same checks at resolution: runtime
availability, wallet purpose and provider entitlement. Immediately before the provider POST, the
proposer re-reads the wallet row and Connection, checks connection, account, vault, source address
and network against the stored intent, and makes the same live money-admission decision a signature
makes. A local refusal marks the intent failed without a POST. Credentials never leave the waist,
and previously decrypted credentials are never carried from preparation into submission. Only the
proposer may call `createFireblocksTransfer` (`pnpm check:value-movement`). This adds no Fireblocks
or Solana RPC requests.
The request returns `processing` while approval is pending. Dashboard transfer reads and the
pending-transfer job reconcile with GET by external ID; they never POST. Unknown outcomes,
including a timeout, missing proposal, or unavailable credentials, stay processing. Do not
create a replacement until the original has been reconciled. A crash before the create call
may require manual reconciliation; automatic resubmission is deliberately not implemented.

Connection deactivation or a failed connection check blocks new payments but does not stop
these status reads. Recovery verifies the stored connection, provider account, vault and source
address before reading the retained active credential. It does not require an active wallet or
a healthy connection, and it stops polling once the payment settles. Credential revocation or
loss of provider access still requires operator intervention; disabling a connection does not
cancel a transfer already accepted by Fireblocks.

Fireblocks transaction ID, status and substatus are visible in SDP. COMPLETED with a valid
Solana signature records confirmation only after the external ID, vault, asset, destination,
and exact decimal payment/net amounts match the stored intent. Missing or mismatched details
stay processing for reconciliation. The existing chain-finality job checks finalization.
Terminal provider failures record their reason. A policy block (`BLOCKED` with
`BLOCKED_BY_POLICY`) records the custody policy refusal instead: the message a refused signature
gets and `CUSTODY_POLICY_REFUSED`, which a replay of the key answers with 422 (HOO-2478). RAW and PROGRAM_CALL
signing answer the same block with 422 `CUSTODY_POLICY_REFUSED`; a `BLOCKED` without that
sub-status keeps the 400 `SIGNING_BLOCKED` operation-policy hint. The transaction details page
refreshes every 15 seconds while pending. The bounded local signing timeout described below does not apply
to these intents.
Existing failed RAW attempts remain failed and are never retried by this implementation.

## Arbitrary transaction proposals and local deadlines

BYOK uses `@solana/keychain-fireblocks@2.0.0` through the existing custody signing
waist. Its `PROGRAM_CALL` contains the entire legacy or v0 wire transaction, including
existing signatures, with `signOnly: true` and `useDurableNonce: false`. No provider
specific instructions or yield-provider allowlist are needed. Fireblocks approvals
must permit the actual programs and accounts. The workspace must support program calls
and use a hot wallet; see the [Fireblocks program-call contract](https://developers.fireblocks.com/reference/interact-with-solana-programs).

The SDK accepts `SIGNED`, verifies the Ed25519 signature against the exact local message
and vault address, and returns only the signature. It does not rebuild the message,
refresh its blockhash or fall back to RAW. Unexpected broadcasting states fail with
`SIGNER_BROADCAST_UNCONFIRMED`; SDP must not submit a replacement. SDP's existing flow
owns admission, sponsorship, blockhash validation and broadcast. Off-chain messages
remain RAW. Managed Fireblocks retains its existing RAW mode.

This is a **bounded signing operation**, not a durable asynchronous proposal API:

- The shared base signing bound is 60 seconds. `custodySigningTimeoutMs({})` gives
  **75 seconds**: the default 60 × 1-second poll budget plus 15 seconds for requests.
  Configuration can raise that bound, capped at **90 seconds**. These are not five-minute
  approval windows. Some workflows have shorter deadlines.
- The SDK makes at most 60 status polls, one second apart by default. Provider response
  time is additional; the outer custody bound aborts in-flight signing at its deadline.
- Poll exhaustion or an abort triggers one best-effort cancel POST, using a separate
  five-second cleanup signal. If create was interrupted before returning an ID, cleanup
  first attempts one GET by external ID. It never resubmits the proposal. An outer timeout
  can return before cleanup finishes; process termination can interrupt cleanup.
- Every RAW and PROGRAM_CALL proposal has a unique caller-supplied `externalTxId`.
  BYOK IDs are the `fbp_` proposal row ID, minted per request before the provider POST;
  the row records its request ID, project, exact wallet, connection, account and vault. The `sdp_fireblocks_signing_timeout` event records the
  external ID, sanitized Fireblocks ID when known, and `cancel_requested`. Request log
  context and the durable proposal row link it to the SDP request.
- A successful cancel response only acknowledges the request. It does not prove
  `CANCELLED`; failures and unknown results remain ambiguous. Operators must inspect
  Fireblocks before retrying. Late approval can race cancellation. A sign-only proposal
  cannot independently broadcast, and SDP discards a signature after its local timeout.

A caller deadline that does not forward an abort signal cannot interrupt the SDK early;
its own polling limit still performs cleanup. The wallet proposal list refreshes pending
provider status on demand. The `reconcile-fireblocks-proposals` cron (every 30 seconds)
reconciles status only for these sign-only rows — the same read-and-record path the page
uses; it never resumes, retries or submits a signing request. Native TRANSFER intents
retain their existing persisted, asynchronous approval/reconciliation flow. Durable
generic asynchronous program-call submission is separate work.

The Signer check uses a sign-only memo program call, verifies and simulates without
broadcasting. It needs an allowed Program Call policy and a funded SDP fee payer;
approve within the signing window. It does not test TRANSFER policy. Privy and other
providers retain their existing signing modes.

## Request budget

All operations below make **zero Solana RPC calls** in the custody adapter:

| Operation                                 | Before                                                                                         | After                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSR generation / download                 | Unsupported                                                                                    | Zero Fireblocks requests                                                                                                                                     |
| Named vault discovery                     | Manual vault-ID entry                                                                          | One Fireblocks GET per page of up to 50 vaults                                                                                                               |
| Initial BYOK verification                 | One address GET for a manually entered vault                                                   | Two Fireblocks GETs per selected vault: current metadata and address; no duplicate primary-address read. Legacy single-ID submissions retain one address GET |
| Credential check                          | Unsupported                                                                                    | One Fireblocks address GET                                                                                                                                   |
| Rotation or rollback verification         | One primary-vault address GET                                                                  | One Fireblocks address GET per distinct vault across the primary and attached wallets; reuse the primary result                                              |
| New vault provisioning                    | Three Fireblocks requests for managed wallets                                                  | Same three requests for managed and BYOK: vault POST, asset POST, address GET; reuse the returned address                                                    |
| Native SOL payment                        | Address GET, RAW POST, approval polls, local blockhash/sponsorship/submission/confirmation RPC | One TRANSFER POST, zero Solana RPC at send; one GET per status poll, throttled to once per 15 seconds per transfer                                           |
| Native USDC payment                       | Same RAW path plus live mint/token-account reads                                               | Same as SOL plus one static catalogue GET on a five-minute cache miss; concurrent reads shared, failures not cached                                          |
| First signature for a wallet              | Managed: address GET, proposal POST, approval polls                                            | Same path for managed and BYOK                                                                                                                               |
| Signing timeout cleanup                   | No cancellation request                                                                        | One cancel POST, plus one external-ID GET only when the create response ID is unknown; zero Solana RPC                                                       |
| Subsequent signatures on a cached adapter | Managed: proposal POST and approval polls                                                      | Same path for managed and BYOK; no duplicate address GET                                                                                                     |

Credential-version changes select a fresh adapter. No provider-account address is inferred from
deployment credentials or another connection's signer cache.

Payment RPC budget for non-native-provider signing: single-payment builds still use one `getLatestBlockhash` call, moved after
instruction preparation. Fast signing adds zero reads. Signing lasting at least 15 seconds
adds one `isBlockhashValid` call per signed transaction (including each slow batch chunk),
whose result gates sponsorship and broadcast. The helper resolves the memoized RPC client
from the open cluster scope; it does not accept a caller-supplied client. This adds no RPC
requests beyond the lifetime check above. There is no automatic rebuild or signing retry.

## Opt-in live tests on local mainnet

`scripts/fireblocks-live.mjs` exercises a running local SDP API using an SDP API key. The
`signer` reaches Fireblocks sign-only PROGRAM_CALL through solana-keychain; `payment` uses native TRANSFER through SDP;
the runner never receives or exports a Fireblocks private key. These commands do not run in CI.

Before testing:

1. Use a production SDP project, a mainnet RPC, and a Fireblocks endpoint matching the customer's
   workspace region. Complete CSR registration and connect the existing SOL vault in the
   dashboard. Enable the connection for runtime execution. Allow TRANSFER initiation and the intended one-time destination in the workspace policy.
   Keep SOL in the source vault for network fees. Program Call permission is needed for the optional signer check.
2. Fund the source vault with the payment asset and enough SOL for fees and any token-account
   rent. Fund SDP's separate local fee payer only if running the optional program-call signer check.
3. Create a production SDP API key bound to the selected wallet. Grant `projects:read`,
   `wallets:read`, and `wallets:write`; payment testing additionally requires `payments:write`
   `payments:read`, and authorization for `payment_transfer_execute`. Keep the API key locally.
4. Copy `docs/ops/fireblocks-live.example.json` to an ignored private path, such as
   `.secrets/fireblocks-mainnet/live-test.json` (directory mode 700, file mode 600). Fill in the
   project ID, SDP custody wallet ID, matching mainnet RPC, and SDP fee payer. For a payment,
   explicitly choose a recipient, mint (`SOL` for native SOL), and decimal amount. The custody
   wallet ID is the SDP row ID, not the numeric Fireblocks vault ID.

From the repository root, enter the SDP key without putting it in shell history (macOS zsh):

```sh
read -rs 'SDP_LIVE_API_KEY?SDP API key: '
export SDP_LIVE_API_KEY
node scripts/fireblocks-live.mjs preflight --config .secrets/fireblocks-mainnet/live-test.json
# Optional: sign-only program-call check, unrelated to native TRANSFER payments.
# node scripts/fireblocks-live.mjs signer --config .secrets/fireblocks-mainnet/live-test.json
```

`preflight` reads the project and wallet from SDP, verifies the mainnet genesis hash, and reads
the source vault account. It does not contact Fireblocks. Only the optional signer mode
checks the separate SDP fee payer, in the same account batch. `signer`
additionally invokes SDP's signer check, creates a real Fireblocks sign-only memo program-call proposal, waits
for approval, verifies the signature, and simulates it. It never broadcasts or moves funds.
Have Fireblocks open and approve promptly because of the synchronous approval limit above.

Only after reviewing the configured destination and amount, explicitly send one real payment:

```sh
node scripts/fireblocks-live.mjs payment \
  --config .secrets/fireblocks-mainnet/live-test.json \
  --send-mainnet --receipt .secrets/fireblocks-mainnet/payment-01.json
unset SDP_LIVE_API_KEY
```

This mode persists the exact payment intent and an idempotency key before submitting it,
then checks SDP's response and the mainnet signature status. It uses the same transfer route
as the dashboard. Approve the proposal in Fireblocks; Fireblocks signs and broadcasts afterward. A pending
result is expected while you approve. Run `node scripts/fireblocks-live.mjs status --config
<config-file> --receipt <same-receipt-file>` to reconcile without submitting again.
Preserve the receipt if the request times out or has an unknown outcome. Reusing the same
command and receipt reuses the same idempotency key; a changed payment is refused. Do not
delete or replace the local database between retries. Use a new receipt path only for an
intentional new payment. Any SDP policy approval must also be completed in the dashboard.

`node --test scripts/fireblocks-live.test.mjs` tests the runner's guards with a fake transport;
it is not evidence of a successful live Fireblocks integration. Report live checks separately.

## Verification

CSR tests independently verify RSA-4096 PKCS#10 signatures with OpenSSL and check that the
actual keychain JWT verifies against the generated CSR public key. Route tests exercise tenant
and project isolation, idempotent generation, expiry, key retirement, encrypted storage, replay,
network pinning, provider isolation, signed paginated vault discovery, multi-vault imports,
provider and database failure rollback, duplicate-vault rejection,
credential rejection, rotation and rollback, wallet ownership, additional vault provisioning,
and GCP cleanup reservations against PostgreSQL. The signing test uses the actual keychain
implementation with mocked Fireblocks HTTP responses and a locally generated Ed25519 signature.
Dashboard tests cover submission, rotation, and the existing Privy lifecycle. These tests do not
replace an approval-policy check against a real Fireblocks workspace.

## Read-only checks on Pay

The minimal integration retains server-generated RSA-4096 keys, CSR download, API user ID
connection, named vault selection and native SOL/USDC transfers. SDP does not create whitelist
entries, edit or publish Fireblocks policies, or automatically import Fireblocks contacts.
Customers manage their address books and transfer policies in Fireblocks. Previously imported
SDP contacts remain intact. The unused address-book and policy-proposal migrations are not
part of this release.

Selecting a destination checks its exact address, asset and network against internal and external
Fireblocks wallets. Only a successful lookup confirming absence shows the whitelist warning.
Pending and approved entries do not prompt. Sending uses the selected address, subject to
Fireblocks' whitelist resolution and the customer's workspace settings.

The recommended Fireblocks Editor API user cannot read active policies. Pay therefore shows
local, dismissible guidance to configure the API user's transfer policy, approvers and designated
signer in Fireblocks. SDP does not call the administrator-only active-policy endpoint or infer
that a policy is missing. Customers do not need to give SDP administrative access.

Each warning category has a “Don’t show again” action. The preference has no expiry and is stored
in this browser, scoped to the signed-in user, organization and project. It survives reloads and
sign-ins; clearing browser storage restores warnings. It neither changes Fireblocks policy nor
suppresses actual payment failures. No backend preferences or extra management permissions are
needed. If browser storage is unavailable, SDP reports that the preference could not be saved.

The internal destination check requires a signed-in human session, project context, exact wallet access and contact read
permission. Contact addresses are resolved on the server and compared with the selected address.
The former whitelist, policy-read, policy setup, draft and publish endpoints are absent, including for admins.

Request budget: a cold destination check makes two parallel GETs (internal/external wallets),
shared for 30 seconds. USDC adds one asset-catalogue GET on a cold five-minute cache. Failed
reads are never cached. Automatic policy reads are removed: one fewer provider request per
cold policy check. Suppressed whitelist warnings skip their advisory checks; payment-time
validation remains active. These changes add zero Solana RPC calls.

## Submission recovery and access revocation

HTTP 400, 401, 403, 422 and 429 create refusals, and immediate terminal Fireblocks failures,
return `TRANSACTION_FAILED`. Retrying the same SDP key/idempotency key does not create a
second provider transaction. Fireblocks transaction creation uses the permanent `externalTxId`
deduplication mechanism, without an `Idempotency-Key` header; vault and asset creation use
separate stable idempotency keys.

An unknown submission is polled by its SDP transfer ID (`externalTxId`). For an unacknowledged
intent, two authenticated 404 lookups separated by at least 24 hours close it as failed. A
provider timeout or authorization error never counts as proof of absence. A transfer with a
known Fireblocks transaction ID is never failed merely because a later lookup returns 404.
There is no automatic replacement POST.

Operators should search Fireblocks by the `externalTxId` or recorded transaction ID, confirm the
source vault and destination, and inspect `fireblocks_transfer_submission_outcome_unknown`,
`fireblocks_transfer_status_unavailable`, `fireblocks_known_transaction_missing`, and
`fireblocks_unaccepted_transfer_expired` events. Errors include their sanitized name/code.
Repair expired credentials or connection access to resume reconciliation. Settlement mismatches
remain processing for investigation; never replace a payment while its outcome is unknown.
A newly initiated payment needs explicit user intent and a new SDP idempotency key.

The live runner's `status` mode reads the existing transfer directly from its receipt, including
when the source wallet is no longer in the operational wallet list. Receipt/key and exact intent
checks still apply. It skips execution eligibility and funding checks; `preflight`, `signer` and
`payment` retain them. Compared with the previous status command, this removes one SDP wallet-list
GET and one Solana `getMultipleAccounts` request; mainnet and confirmed-signature checks remain.

Native transfers can execute in Fireblocks after SDP access is revoked. Cancel pending transfers
from SDP or cancel/reject them in Fireblocks as part of revocation/incident response; cancellation
can race execution.
See the **proposed, not yet approved** [ADR 0007 exception](../decisions/0007-money-admission.md#proposed-exception-fireblocks-native-transfers-pr-2455).

Live-test receipts bind the payment to the SDP API key via a slow one-way fingerprint. Keep the
same key and receipt when retrying; a changed key or legacy unbound receipt is refused. The
result receipt stores only a validated SDP transfer ID, never a provider response or secret.

## Manual cancellation in SDP

Organization administrators can use **Wallets → Overview → Fireblocks approvals** for
both native transfers and sign-only requests. The internal dashboard list and cancellation
routes require `wallets.configure` and a human session; they are not public API-key routes.
Each cancellation validates project and wallet access before the shared required
`Idempotency-Key` step. Audit intent is written before provider cancellation.

Migration `0229_fireblocks_signing_proposals.sql` stores sign-only proposal metadata before
creation, with tenant RLS and a project/wallet index. It contains no payload bytes, keys or
signatures. Older sign-only proposals are not backfilled. The SDK's status hook and manual
cancellation claim serialize in PostgreSQL: if cancellation wins, a later signature cannot
be returned to an SDP broadcaster. If signature acceptance wins, cancellation cannot undo
it. Confirmed terminal statuses never regress to an older pending poll response.

Both cancellation paths resolve the retained credential and check the stored account,
connection, wallet, external ID, operation and asset before a cancel POST. Disabling
execution does not block cleanup, but a revoked provider credential still does. Unknown
provider outcomes remain pending; `success: true` from cancel is an acknowledgement, not
`CANCELLED`. A native TRANSFER can still execute during cancellation; its existing settlement
validation records the real result. No automatic replacement is submitted.

Request budget: each cancellation makes one status GET, at most one cancel POST and one
follow-up GET; zero Solana RPC. The paginated list reads at most 20 pending proposals per
page, throttled to one status GET per proposal per 15 seconds across concurrent requests.
Terminal rows need no provider read. SDK tracking writes on status transitions, not each
identical poll. List pages show the last known status during provider outages. Historical
rows are paginated; a retention policy remains follow-up work.

## Scheduled reconciliation and metrics

`reconcile-fireblocks-proposals` is an independent, always-enabled 30-second cron,
registered separately for sandbox and production. It selects at most 100 pending
native TRANSFER and sign-only RAW/PROGRAM_CALL rows together, oldest `updated_at`
first, with five concurrent reads. A failed Solana settlement job cannot skip or
hold this registration. Dashboard and worker reads share the existing 15-second
per-row claim. Attempts rotate the queue even when credentials or provider reads
fail, and a terminal observation cannot regress a terminal row.

This job only reads Fireblocks and persists status. It never signs, broadcasts,
resubmits, or cancels, and never reconstructs a transaction from a sign-only row.
An approval after the synchronous request ended does not resume that request.
There is no maximum pending-approval age or new expiry policy. The existing
recovery rule for a never-acknowledged native submission proven absent by two
24-hour-separated authenticated 404s is unchanged.

The initial operational target is **no pending row unvisited for more than 180
seconds**, per environment, under normal provider/database availability and up to
500 pending rows across both kinds. Previously, 50 native rows per minute meant
500 rows needed ten scheduled visits (about ten minutes), after the Solana work.
Now 100 rows per 30-second slot gives five visits (about 150 seconds plus the last
batch's provider latency). With five concurrent reads averaging at most one
second including credential/database overhead, a full batch takes about 20
seconds. Slow reads, overlap or a larger backlog can breach the target and alert;
this is a starting target, not a measured production SLO or a revocation guarantee.
The database regression visits 500 distinct old approvals in five passes with no
expiry and at most five reads in flight. Live p99 settlement latency is not yet
measured; no provider completion timestamp is inferred from proposal creation.

Each completed pass emits `sdp_api_fireblocks_reconciliation_tick` with:

| Field                                                | Meaning                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                                        | Sandbox or production project environment.                                                                                                                                                                          |
| `pending`, `pending_transfers`, `pending_signing`    | Remaining rows, using exactly the candidate predicate. No pending-age cutoff.                                                                                                                                       |
| `oldest_unpolled_age_ms`                             | Time since the oldest pending row's last poll attempt, or creation when never polled; zero for an empty queue.                                                                                                      |
| `selected`, `polled`, `skipped`, `settled`, `failed` | Selected rows, completed provider reads, lost-claim/no-longer-pending rows, rows closed by observation (including failures/cancellation), and failed row attempts. Rows beyond the batch limit remain in `pending`. |
| `duration_ms`, `limit`, `concurrency`, `target_ms`   | Wall time and the operating bounds.                                                                                                                                                                                 |

A row failure also emits `sdp_api_fireblocks_reconciliation_failed` with a safe
proposal ID/error name/code. Other rows continue, then the job throws so its
`sdp_cron_run` is `error`. A candidate or aggregate-query failure emits no invented
zero backlog; cron errors and tick-absence alerts cover it. Polling age measures
attempts, so the failure alert must stay enabled alongside the age alert.

The companion `sdp-infra` change adds the **SDP Fireblocks reconciliation** Grafana
dashboard and stage/prod alerts: polling age above 180 seconds for a minute, failed
rows for a minute, and no tick for three minutes (separate sandbox/production
absence rules). Empty queues still emit ticks. Deploy the API worker before
activating these rules. Runbook:
[Fireblocks reconciliation](https://github.com/solana-foundation/sdp-infra/blob/main/docs/runbooks/fireblocks-reconciliation.md).

Request budget before/after: each visited row retains one wallet/credential
resolution and one Fireblocks GET; zero Solana RPC and zero provider POSTs. The
new worker caps the combined batch at 100 GETs, five in flight. It performs one
candidate query and one post-run aggregate query; per-row lookup, claim and status
writes are scoped to the recorded organization/project. Native wallet resolution
currently uses two owner queries plus one credential query; encrypted DB credentials
need no external fetch, while Secret Manager-backed credentials retain their existing
secret read. The signing queue has a concurrent partial pending index (0230).

Principal persistence, re-admission during polling and automatic cancellation on
key/member revocation remain intentionally unimplemented (PRO-2468/2469/2470).
Manual cancellation remains available. No permission-refusal or revocation-latency
metric is fabricated by this read-only job.

## Sandbox evidence still required

Mock HTTP tests prove SDP's request shape, signature checks, deadline signalling and
single cancellation attempt. They do not establish Fireblocks workspace behavior.
For PRO-2474, use a designated sandbox workspace and retain sanitized transaction IDs
and timestamps for RAW, PROGRAM_CALL and TRANSFER:

1. Confirm GET by `externalTxId` finds each operation, including an interrupted create.
2. Attempt cancellation in SUBMITTED, pending approval, pending signature and later
   states. Record the acknowledgement and final status separately.
3. Approve after local timeout; verify cancellation races and that sign-only proposals
   never broadcast. Verify that a successful program call signs the submitted bytes.
4. Separately establish whether provider-broadcast program calls refresh expired
   blockhashes before implementing durable async submission. This branch does not
   enable that mode or durable nonce accounts.

## Stable-train requirements coverage

Scope reviewed against all 19 issues in **Fireblocks BYOK to stable** on 2026-11-12.
This change implements beta sign-only proposals, cancellation safeguards and docs;
it keeps BYOK maturity at beta — a stable promotion is a separate, later one-line
maturity change — and does not declare the entire launch gate complete.

| Issue                                                     | Coverage in this change / remaining work                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PRO-2342](https://linear.app/solana-fndn/issue/PRO-2342) | BYOK maturity stays beta in this change; managed maturity and manual organization enablement retained. Operational evidence, launch approvals and the stable promotion remain separate.                                                                                                       |
| [PRO-2475](https://linear.app/solana-fndn/issue/PRO-2475) | Per-proposal external IDs, timeout/abort cancellation, safe diagnostic IDs and tests for RAW and PROGRAM_CALL. Durable proposal-row/request correlation, manual cancellation and scheduled status recovery are included; recovery never resumes or broadcasts an abandoned sign-only request. |
| [PRO-2476](https://linear.app/solana-fndn/issue/PRO-2476) | Corrected base/default/capped signing deadlines and documented late-approval behavior.                                                                                                                                                                                                        |
| [PRO-2363](https://linear.app/solana-fndn/issue/PRO-2363) | Updated existing customer setup/rotation/teardown guide with program-call policies, approval deadlines, manual cancellation and cancellation limits; publishes with the beta channel. Annotated workspace screenshots remain outstanding.                                                     |
| [HOO-2478](https://linear.app/solana-fndn/issue/HOO-2478) | Existing policy-refusal normalization retained across the SDK upgrade; tests include PROGRAM_CALL and RAW. Pending/unknown/non-policy failures remain distinct.                                                                                                                               |
| [PRO-2356](https://linear.app/solana-fndn/issue/PRO-2356) | Design and operational boundaries documented above; manual enablement remains. The issue discussion records a STRIDE-session waiver; this change does not supply an independent security sign-off.                                                                                            |
| [PRO-2435](https://linear.app/solana-fndn/issue/PRO-2435) | Bounded sign-only program calls and RAW cleanup included. Durable generic async approvals, the shared native-transfer waist and recurring workflows remain separate. PRs #2863/#2864 were open when reviewed; neither is included.                                                            |
| [PRO-2474](https://linear.app/solana-fndn/issue/PRO-2474) | Mocked regressions and a manual sandbox matrix provided; live cancellation/lookup/blockhash evidence remains outstanding.                                                                                                                                                                     |
| [PRO-2466](https://linear.app/solana-fndn/issue/PRO-2466) | Direct-transfer-only API restriction deliberately excluded: it conflicts with this branch's arbitrary stable proposal scope.                                                                                                                                                                  |
| [PRO-2467](https://linear.app/solana-fndn/issue/PRO-2467) | Direct-transfer-only dashboard filtering excluded for the same reason.                                                                                                                                                                                                                        |
| [PRO-2468](https://linear.app/solana-fndn/issue/PRO-2468) | Initiating money principal persistence on native transfers is outside this change (separate PR #2864).                                                                                                                                                                                        |
| [PRO-2469](https://linear.app/solana-fndn/issue/PRO-2469) | Native-transfer re-admission and cancellation on each poll remain outstanding.                                                                                                                                                                                                                |
| [PRO-2470](https://linear.app/solana-fndn/issue/PRO-2470) | Immediate cancellation sweep after principal revocation remains outstanding.                                                                                                                                                                                                                  |
| [PRO-2471](https://linear.app/solana-fndn/issue/PRO-2471) | Independent 30-second, per-environment read-only lane for native transfers and signing proposals; shared batch limit 100, concurrency five, queue rotation and isolation/failure tests included.                                                                                              |
| [PRO-2472](https://linear.app/solana-fndn/issue/PRO-2472) | 180-second polling-age target, per-run backlog/age/duration/outcome metrics and companion sdp-infra dashboard/alerts included. Live p99 settlement measurements and revocation-to-cancel metrics remain outstanding; revocation enforcement is deliberately deferred.                         |
| [PRO-2473](https://linear.app/solana-fndn/issue/PRO-2473) | Pending-approval expiry remains deliberately omitted, including the proposed seven-day limit.                                                                                                                                                                                                 |
| [PRO-2364](https://linear.app/solana-fndn/issue/PRO-2364) | Policy-absence detection, audit and alert remain outstanding. Editor credentials cannot read active policies; a dismissible reminder is not detection.                                                                                                                                        |
| [PRO-2365](https://linear.app/solana-fndn/issue/PRO-2365) | Dependency-register verification, sandbox/production workspace setup and contacts require operational follow-through.                                                                                                                                                                         |
| [PRO-2422](https://linear.app/solana-fndn/issue/PRO-2422) | Already Done; issue discussion says KYB is not required. No code change.                                                                                                                                                                                                                      |

The existing native-transfer admission exception still needs its named review under
[PRO-2368](https://linear.app/solana-fndn/issue/PRO-2368). Beta publication is not evidence
that the outstanding operational or security requirements have been satisfied.
