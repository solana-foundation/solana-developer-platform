# Fireblocks BYOK

Fireblocks **BYOK is beta**. Set `SDP_RELEASE_CHANNEL=beta` (or `experimental`) on the
API deployment to offer it. The dashboard consumes the API's provider availability;
stable refuses new registrations, installation, credential rotation, wallet creation,
signing, and payment submission. Existing payments still reconcile through read-only
provider requests, and cancellation/deactivation remain available. Managed Fireblocks
custody is also beta on current main. Release channel and Solana network are independent:
a beta deployment can connect to mainnet.

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
signing path. Batch and custom-program signing still use
the existing solana-keychain adapter; they have not been converted to native transfers.

SDP sends the exact selected address using `ONE_TIME_ADDRESS`. Fireblocks resolves matching
whitelisted destinations in its workspace; unmatched destinations require one-time transfers
to be allowed by the workspace. The read-only SDP checks do not change the submitted address.
An SDP contact alone does not whitelist an address. Manage whitelisting in Fireblocks. The SDP memo becomes a Fireblocks note, not a Solana memo instruction.

Before submission, SDP durably stores the intent and atomically claims a single create attempt.
The SDP transfer ID is Fireblocks' permanent `externalTxId`; transaction creation does not
send Fireblocks' time-limited `Idempotency-Key` header. SDP separately deduplicates the caller's
request using its own idempotency key.
Immediately before the provider POST, SDP resolves custody access again and checks the current
connection, account, vault, source address and network against the stored intent, then rechecks
the caller's live money authorization. A local refusal marks the intent failed without a POST;
previously decrypted credentials are never carried from preparation into submission. This adds
no Fireblocks or Solana RPC requests.
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
Terminal provider failures record their reason. The transaction details page refreshes every
15 seconds while pending. The five-minute local signing timeout does not apply to these intents.
Existing failed RAW attempts remain failed and are never retried by this implementation.

Privy and other signing operations retain solana-keychain. Fireblocks' separate Signer check
still proposes RAW signing and simulates without broadcasting; it requires RAW enabled and a
funded SDP fee sponsor and has the keychain adapter's synchronous approval window.

## Request budget

All operations below make **zero Solana RPC calls** in the custody adapter:

| Operation | Before | After |
| --- | --- | --- |
| CSR generation / download | Unsupported | Zero Fireblocks requests |
| Named vault discovery | Manual vault-ID entry | One Fireblocks GET per page of up to 50 vaults |
| Initial BYOK verification | One address GET for a manually entered vault | Two Fireblocks GETs per selected vault: current metadata and address; no duplicate primary-address read. Legacy single-ID submissions retain one address GET |
| Credential check | Unsupported | One Fireblocks address GET |
| Rotation or rollback verification | One primary-vault address GET | One Fireblocks address GET per distinct vault across the primary and attached wallets; reuse the primary result |
| New vault provisioning | Three Fireblocks requests for managed wallets | Same three requests for managed and BYOK: vault POST, asset POST, address GET; reuse the returned address |
| Native SOL payment | Address GET, RAW POST, approval polls, local blockhash/sponsorship/submission/confirmation RPC | One TRANSFER POST, zero Solana RPC at send; one GET per status poll, throttled to once per 15 seconds per transfer |
| Native USDC payment | Same RAW path plus live mint/token-account reads | Same as SOL plus one static catalogue GET on a five-minute cache miss; concurrent reads shared, failures not cached |
| First signature for a wallet | Managed: address GET, proposal POST, approval polls | Same path for managed and BYOK |
| Subsequent signatures on a cached adapter | Managed: proposal POST and approval polls | Same path for managed and BYOK; no duplicate address GET |

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
`signer` reaches Fireblocks RAW through solana-keychain; `payment` uses native TRANSFER through SDP;
the runner never receives or exports a Fireblocks private key. These commands do not run in CI.

Before testing:

1. Use a production SDP project, a mainnet RPC, and a Fireblocks endpoint matching the customer's
   workspace region. Complete CSR registration and connect the existing SOL vault in the
   dashboard. Enable the connection for runtime execution. Allow TRANSFER initiation and the intended one-time destination in the workspace policy.
   Keep SOL in the source vault for network fees. RAW is only needed for the optional signer check.
2. Fund the source vault with the payment asset and enough SOL for fees and any token-account
   rent. Fund SDP's separate local fee payer only if running the optional RAW signer check.
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
# Optional: RAW signer check, unrelated to native TRANSFER payments.
# node scripts/fireblocks-live.mjs signer --config .secrets/fireblocks-mainnet/live-test.json
```

`preflight` reads the project and wallet from SDP, verifies the mainnet genesis hash, and reads
the source vault account. It does not contact Fireblocks. Only the optional signer mode
checks the separate SDP fee payer, in the same account batch. `signer`
additionally invokes SDP's signer check, creates a real Fireblocks RAW memo proposal, waits
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

Native transfers can execute in Fireblocks after SDP access is revoked. Cancel or reject pending
transfers in Fireblocks as part of revocation/incident response; cancellation can race execution.
See the **proposed, not yet approved** [ADR 0007 exception](../decisions/0007-money-admission.md#proposed-exception-fireblocks-native-transfers-pr-2455).

Live-test receipts bind the payment to the SDP API key via a slow one-way fingerprint. Keep the
same key and receipt when retrying; a changed key or legacy unbound receipt is refused. The
result receipt stores only a validated SDP transfer ID, never a provider response or secret.
