# Fireblocks BYOK

Fireblocks connections use the same project-scoped encrypted credential lifecycle as Privy:
installation, credential checks, replacement, rotation, rollback, deactivation, and secret
retirement. Organization entitlement to Fireblocks is still required. Deploy migration
`0127_fireblocks_byok.sql` and `0128_fireblocks_csr_requests.sql` before the API. They extend
the GCP reservation and cleanup constraints, enforce one unfinished Fireblocks installation,
and add tenant-isolated, encrypted CSR registration storage.

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

Rotation requires access to the original vault, network, and Solana address. API user keys
may change, but a credential cannot silently redirect the connection to another vault or
workspace. Each signing request also checks the requested wallet's ownership and the signer
address. Deactivation in SDP does not revoke the API user in Fireblocks.

## Transaction approval

Direct SOL and USDC payments through `POST /v1/payments/transfers` use Fireblocks'
[TRANSFER operation](https://developers.fireblocks.com/api-reference/transactions/create-a-new-transaction).
SDP resolves the exact project wallet and its encrypted BYOK credential. Fireblocks builds the
transaction, applies the workspace's approvals, signs and broadcasts. The source vault needs
SOL for fees (also when sending USDC); SDP's local/Kora fee sponsor is not involved.
No RAW-signing permission or SDP Signer check is required for these payments.

USDC is resolved by its exact Solana mint (`issuerAddress`) and `nativeAsset` in Fireblocks'
asset catalogue, never by symbol alone. Other tokens, ramp-deposit reuse and managed Fireblocks
wallets are rejected by this direct-payment path. Batch and custom-program signing still use
the existing solana-keychain adapter; they have not been converted to native transfers.

SDP resolves an approved matching Fireblocks whitelist entry to its internal/external wallet ID.
An unmatched destination uses `ONE_TIME_ADDRESS`, which must be allowed by the workspace.
An SDP contact alone does not whitelist an address; the proposal and import features are described
below. The SDP memo becomes a Fireblocks note, not a Solana memo instruction.

Before submission, SDP durably stores the intent and atomically claims a single create attempt.
The SDP transfer ID is both Fireblocks' permanent `externalTxId` and the request idempotency key.
The request returns `processing` while approval is pending. Dashboard transfer reads and the
pending-transfer job reconcile with GET by external ID; they never POST. Unknown outcomes,
including a timeout, missing proposal, or unavailable credentials, stay processing. Do not
create a replacement until the original has been reconciled. A crash before the create call
may require manual reconciliation; automatic resubmission is deliberately not implemented.

Fireblocks transaction ID, status and substatus are visible in SDP. COMPLETED with a valid
Solana signature records confirmation; the existing chain-finality job checks finalization.
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
| Credential check or rotation check | Unsupported | One Fireblocks address GET |
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
whose result gates sponsorship and broadcast. There is no automatic rebuild or signing retry.

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

## Address book and contact imports

`FIREBLOCKS_CONTACT_SYNC_ENABLED` is a host-level API setting, enabled when unset or
`true`. Set it to `false` to stop automatic imports; existing contacts remain.
The pending-transfer reconciliation tick refreshes active Fireblocks connections at most
once every five minutes. Opening the contact directory also triggers a due refresh, including
on local deployments with cron disabled. A database lease prevents duplicate work across replicas.

Approved SOL and USDC addresses from Fireblocks internal and external whitelisted wallets
are imported into the connection's SDP project, using their Fireblocks names. Other chains,
assets, and pending entries are excluded. Existing Solana addresses are linked instead of
creating duplicates; edited names and archived contacts are preserved. Remote removals never
silently delete an SDP contact or redirect its address. This is an inbound sync; edits to SDP
contacts do not automatically change Fireblocks.

Selecting a destination for a Fireblocks payment checks the exact address, asset and network.
A neutral toast offers to request whitelisting only after a successful lookup confirms absence.
Approved and pending addresses do not prompt. Lookup failures never count as an empty address book.
The action creates an external wallet and adds its asset address using the organization's
BYOK API user. Fireblocks retains its workspace approval and activation-delay controls.
The API user must have permission to create external wallets and add their assets.
See [Fireblocks' endpoint permissions](https://developers.fireblocks.com/api-reference/external-wallets/add-an-asset-to-an-external-wallet).

The internal dashboard endpoints require the current project, exact wallet access and contact
read permission; proposing additionally requires contact write permission. Contact addresses
are resolved on the server and compared with the selected address. A durable claim and separate
provider idempotency keys prevent repeated clicks or ambiguous responses from duplicating requests.
Unconfirmed submissions require inspection in Fireblocks; SDP never automatically resubmits.
Definite rejections can be retried through a new explicit toast action after correcting the cause.
Apply migration `0129_fireblocks_address_book.sql` before deploying.

Request budget: previously selecting a contact made zero Fireblocks requests. Now a cold lookup
makes two parallel GETs (internal/external wallets), shared for 30 seconds within an API process.
USDC adds one asset-catalogue GET on a cold five-minute catalogue cache. Changing payment amounts
makes no additional lookups. Sync reuses these caches. An explicit proposal makes two fresh GETs
and, only if absent, two POSTs; selecting a contact never proposes or sends a payment. No Solana
RPC calls are added.

## Transfer policy setup from Pay

Apply `0130_fireblocks_policy_proposals.sql` before deploying this feature. Pay reads the active
TRANSFER policy using the selected wallet's BYOK credential and evaluates the first matching
rule for the API user, source vault, exact asset, destination category/whitelist ID, and amount.
Denied reads and unrecognized conditions never count as missing policies. Bounded fiat amounts,
amount-over-time quotas, group-based initiators and mixed account selectors require review in
Fireblocks; SDP does not guess exchange rates, group membership or policy precedence.
A custom blocking rule also requires review there. Only an understood catch-all block can have
a new rule inserted immediately before it; earlier rules retain their order and contents.

Policy reads require a Fireblocks Owner, Admin or Non-Signing Admin API user; directory reads
require Admin or Non-Signing Admin. Policy Editor API availability may require enablement by
Fireblocks. An Editor connection continues to send payments but cannot use this management
feature. See the [official Policy Editor API](https://github.com/fireblocks/ts-sdk/blob/master/docs/apis/PolicyEditorV2Api.md)
and [console user directory](https://github.com/fireblocks/ts-sdk/blob/master/docs/apis/ConsoleUserApi.md).

Only signed-in SDP users with `custody:admin` can configure or submit a policy; SDP API keys
cannot. The setup form reads active human approvers/signers and approved user groups from the
connected workspace. Its defaults are the selected vault and asset, any whitelisted address,
zero to unlimited USD per transaction, request approval, and initiator approval disabled.
Users must explicitly choose approval sets, thresholds and human designated signers.
The API user is never offered as an approver or signer. Destination alternatives are the selected
whitelisted wallet or any one-time address; the latter still requires the workspace setting.

Saving uses `PUT /v1/policy/draft` for TRANSFER only. It preserves existing rules, validates the
provider response against the reviewed rule set, and records an audited, tenant-isolated claim.
A separate click uses `POST /v1/policy/draft` with the exact saved draft ID after re-reading the
active policy and draft revisions. This asks Fireblocks to publish under its governance; it does
not approve a policy or send a payment on the user's behalf. A saved draft can be resumed for the
same payment selection. Existing external drafts, changed revisions and uncertain writes block
further edits until reviewed; ambiguous requests are never automatically repeated.

Fireblocks' documented draft API does not expose a conditional-write revision/ETag. SDP checks
immediately before writes and again before submission, but cannot eliminate a simultaneous Console
edit between a GET and PUT. Serialize policy edits across SDP and Fireblocks. Unknown submission
states need operator reconciliation in Fireblocks before a local proposal is released.

Budget: this feature adds zero Solana RPCs. A cold policy check adds one Fireblocks policy GET
and reuses the address-book lookup (two GETs on cache miss); successful policy reads are shared
for 15 seconds. Opening setup uses eight fresh GETs: policy, both address books, draft, three
directories, and vault metadata. Saving revalidates those inputs and adds two revision GETs and
one PUT. Submission uses two GETs and one POST. USDC adds the existing catalogue GET on a cache
miss. Nothing writes merely because a source, destination, asset or amount was selected.

The local workspace returned HTTP 403 for policy/directory reads during implementation, so live
policy creation/publication has not been verified. Regression tests use recording HTTP fixtures
and isolated PostgreSQL/Redis; production handlers always call the real Fireblocks API.
