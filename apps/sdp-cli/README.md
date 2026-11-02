# SDP CLI

The `sdp` command covers 291 SDP API operations across project and organization administration, wallets, payments, Earn, DvP, issuance, Private Channels, Helius Rings, compliance, address lookup, dashboard setup, webhooks, health, and discovery. The three operator-only onboarding-allowlist routes are outside the CLI's scope.

See the generated [complete command and endpoint reference](./COMMANDS.md). Each invocation makes one request. `--help` describes the operation's authentication, input, signing responsibilities, and output.

## Command names and signing flows

Commands name the resource and action. `list`, `get`, `create`, `update`, and `archive` describe ordinary resource operations. Transaction flows name their execution stage:

| Command pattern                                                    | What happens                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `transfers execute`, `transfer-batches execute`                    | Request provider signing and submission                                        |
| `onramps start`, `offramps start`                                  | Start a tracked provider flow and create its SDP transfer                      |
| `earn deposits execute`                                            | Request a deposit through the connected signing provider                       |
| `earn deposits build-unsigned-transaction`                         | Build bytes for the caller to sign outside the CLI                             |
| `earn deposits submit-signed-transaction`                          | Send the caller's signed bytes to SDP for validation, recording, and broadcast |
| `earn positions provider-signed list` / `caller-signed list`       | Read the specified signing flow's positions                                    |
| `earn portfolio-accounts allocation update`                        | Change a provider portfolio account's allocation                               |
| `issuance tokens mint execute` / `mint build-unsigned-transaction` | Execute through the provider or build for caller signing                       |
| `issuance tokens deploy confirm-submitted-transaction`             | Verify and record an already-submitted deployment                              |
| `payment-links transactions build-sponsored-transaction`           | Build a fee-sponsored transaction still requiring the payer's signature        |
| `subscription-plans create-record`, `subscriptions create-record`  | Store an SDP record                                                            |
| `subscriptions authorize build-unsigned-transaction`               | Build the on-chain authorization transaction                                   |
| `helius-rings operations execute` / `resume-execution`             | Start a new intent or resume a named existing one                              |
| `custody connections complete-installation`                        | Explicitly finish a pending provider installation                              |
| `webhooks clerk deliver`                                           | Forward the captured signed webhook payload                                    |

Command words precede all positional IDs: `sdp issuance tokens mint execute TOKEN_ID ...`. This naming replaces the earlier CLI vocabulary; old names have no compatibility aliases. Use the command reference or group `--help` to update scripts. API operation IDs and response field names remain those of the API, including Earn's `programId` and `programs` fields for portfolio accounts.

## Run from this workspace

```sh
pnpm install
pnpm cli --help
pnpm cli projects list
pnpm cli projects get prj_example
pnpm cli projects update prj_example --name "Payments"
pnpm cli organizations get org_example
```

Use Node.js 24.22.1 or newer. To build the bundled executable:

```sh
pnpm --filter @sdp/cli build
node apps/sdp-cli/dist/cli.js --help
```

The package declares `sdp` as its binary. It is private while the command surface is being built out.

## Authentication and configuration

Set `SDP_API_KEY` to use an API key. Keys remain bound to their project and explicit grants; the server enforces access. Project member and API-key administration requires a Clerk session token for the active organization in `SDP_TOKEN`. Project updates require `projects.manage`, which API keys cannot hold, so use a session token for updates as well. Organization creation, updates, and mainnet-access administration also require a Clerk session. Creation requires a signed-in session with **no active organization**; updates and mainnet access require a session for the organization being changed. Session tokens expire; provide a fresh token when the API returns 401.

| Flag             | Environment variable  | Default                                         |
| ---------------- | --------------------- | ----------------------------------------------- |
| `--api-url`      | `SDP_API_URL`         | Hosted API (`@sdp/types/site`)                  |
| `--api-key`      | `SDP_API_KEY`         | Used for account-authenticated API-key commands |
| `--token`        | `SDP_TOKEN`           | Required for session administration             |
| `--project`      | `SDP_PROJECT_ID`      | No default project                              |
| `--organization` | `SDP_ORGANIZATION_ID` | No default organization                         |
| `--timeout-ms`   | `SDP_TIMEOUT_MS`      | `30000`                                         |

Flags override environment variables. Explicit credential flags select the credential even when environment credentials exist; otherwise set only one of `SDP_API_KEY` and `SDP_TOKEN`. A positional project ID overrides `--project`, which overrides `SDP_PROJECT_ID`. A positional organization ID overrides `--organization`, which overrides `SDP_ORGANIZATION_ID`. Selecting an ID chooses the request path; the credential still determines which organization you can access. The API URL is an origin or proxy base path before endpoint paths; HTTP is allowed for loopback development servers. Credentials are never persisted. Prefer environment variables so credentials do not enter shell history.

## Health and API discovery

These six commands require no credentials or project selection. SDP API keys, session tokens, and tenant selectors are omitted even when configured. `--api-url` selects the deployment; its release channel and publication rules determine the served documents.

| Command                 | Endpoint and result                                                     |
| ----------------------- | ----------------------------------------------------------------------- |
| `health check`          | `GET /health`; bare health/build JSON                                   |
| `health readiness`      | `GET /health/ready`; readiness report                                   |
| `api openapi get`       | `GET /openapi.json`; the deployment's public OpenAPI JSON               |
| `api docs get`          | `GET /docs`; Swagger HTML encoded as a JSON string                      |
| `api ai-discovery get`  | `GET /llms.txt`; AI discovery text encoded as a JSON string             |
| `api root-redirect get` | `GET /`; reports `{status: 302, location: "/health"}` without following |

```sh
pnpm cli health check
pnpm cli health readiness
pnpm cli api openapi get --include-headers
pnpm cli api openapi get --if-none-match 'W/"CAPTURED_ETAG"'
pnpm cli api docs get
pnpm cli api ai-discovery get
pnpm cli api root-redirect get
```

Each command makes one request and performs no automatic retry or polling. Health preserves `version`, `environment`, and `releaseChannel`. Readiness preserves `revision`, `commit`, and dependency checks; `egress` stays absent where the API omits it. A 503 exits with code 1, produces no stdout, and retains the entire `not_ready` report under `error.details` on stderr. A malformed report is an invalid-response error, not an invented health state.

`--include-headers` wraps a successful response as `{body, status, headers}`; response header names are lowercase. For OpenAPI, read `headers.etag` and pass that exact validator with `--if-none-match`. Validator lists and `*` are accepted. A matching 304 exits successfully and reports `{status: 304, notModified: true, etag, cacheControl}`; no local document cache is maintained or filled in. The CLI returns the fetched public document unchanged and does not merge its broader internal command contract or force a different release channel.

HTML and plain text remain JSON strings on stdout. To extract their text when piping, use the built binary with a JSON decoder, for example `node apps/sdp-cli/dist/cli.js api ai-discovery get | jq -r .`. The CLI never executes HTML, opens a browser, or fetches linked scripts, stylesheets, or documents. `api root-redirect get` observes its documented redirect in one request; other operations continue to refuse redirects. Body fields, output-file flags, and idempotency keys are unsupported by these commands.

## Wallet balances and onboarding status

```sh
pnpm cli wallets balances get PROVIDER_WALLET_ID
pnpm cli wallets balances get PROVIDER_WALLET_ID --minimum-slot 0
pnpm cli onboarding status get
```

`wallets balances get` calls `GET /v1/payments/wallets/{walletId}/balances` with the provider `walletId` returned by `wallets list`, rather than the wallet record `id` or public key. It requires `wallets.read`. An API key uses its bound project and wallet access; a Clerk session needs `--project` or `SDP_PROJECT_ID`.

`--minimum-slot` is optional and accepts a canonical decimal integer from `0` through `9007199254740991`. Leading zeros, signs, fractions, exponents, and unsafe integers are rejected before the request. The string is sent unchanged as `minimumSlot`; the API requires confirmed account state at or after that slot and acknowledges the bound in `data.balanceReadContext.minimumSlot`. Omission sends no bound. Raw token amounts and display amounts remain strings; zero, absent pricing, and explicit zero USD values are preserved. If any required SOL or SPL read fails, the API returns 503 and the CLI reports that error without partial or invented balances.

`onboarding status get` calls `GET /v1/onboarding/status` with `SDP_TOKEN` or `--token`. The Clerk session must carry an active Clerk organization and usable email; it can be used before that organization is linked to SDP. API keys are refused. No project is required or sent, and configured project/organization selectors do not override the Clerk claims. The API checks active membership or a valid pending invitation when the organization is linked.

An unlinked response preserves `linked: false`, `organization: null`, and `setup: null`. A linked response preserves the organization and its setup state, default sandbox custody providers, completion time, version, and `canManage` value. Reading status never creates an organization, advances setup, or polls for a link. Both commands make one GET, print the API envelope unchanged, perform no automatic retries, and accept no body or idempotency key.

## Commands

```sh
sdp projects list [--include-archived]
sdp projects get [projectId]
sdp projects update [projectId] [--name NAME] [--description TEXT]
    [--settings JSON] [--clear-description] [--clear-settings]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp projects provider-availability get [projectId]
sdp projects members list [projectId]
sdp projects api-keys list [projectId]
sdp projects api-keys create [projectId] --name NAME --grant ACTION
    --wallet-scope all|selected [--wallet-id ID] [--allowed-ip IP_OR_CIDR]
    [--description TEXT] [--expires-at ISO_TIMESTAMP] [--data JSON|@file.json|-]
```

```sh
sdp organizations create --name NAME [--data JSON|@file.json|-]
sdp organizations get [orgId]
sdp organizations update [orgId] [--name NAME] [--settings JSON]
    [--default-environment sandbox|production] [--allowed-ip IP_OR_CIDR]
    [--clear-allowed-ips] [--data JSON|@file.json|-]
sdp organizations mainnet-access get [orgId]
sdp organizations mainnet-access request [orgId] --country-code CODE
    --terms-version VERSION --accept-terms true [--data JSON|@file.json|-]
sdp organizations mainnet-access notify [orgId]
sdp organizations provider-availability get [orgId]
```

Organization creation returns the new organization and its `clerkOrganizationId`, and creates Sandbox and Production projects. After creation, activate that Clerk organization and provide a fresh token for subsequent organization commands. The CLI does not switch or persist your session. Repeating creation with the same name resumes or returns the caller's organization; another name is refused by the server.

Organization updates accept `name` and settings containing `defaultEnvironment` and `allowedIpAddresses`. Repeat `--allowed-ip` to replace the complete organization allowlist; `--clear-allowed-ips` sends an empty array, removing that restriction for API keys. The server validates and canonicalizes IP addresses and CIDRs. Use `--settings` instead of individual settings flags, or `--data` instead of all body flags. Organization settings cannot be cleared with `null`.

```sh
pnpm cli organizations update org_example --default-environment sandbox
pnpm cli organizations update org_example --allowed-ip 203.0.113.0/24 --allowed-ip 2001:db8::/32
pnpm cli organizations provider-availability get org_example
```

Organization deletion has been removed from the API and CLI. Provider access returns the existing internal view of provider entitlements, configuration, and enablement, including every known provider. These commands do not publish the organizations API in public OpenAPI or AI resources. There is no organization-list endpoint.

Mainnet access requires an organization admin's Clerk session and no selected project. `mainnet-access get` reads the current request and deployment availability. `mainnet-access request` records the explicitly selected jurisdiction and acceptance of the exact Terms and Conditions version the admin reviewed; it requests operator approval. `--accept-terms true` is required, never inferred. A recorded request can have `notified: false`; `mainnet-access notify` explicitly resends that recorded request. The CLI makes no automatic follow-up, infers no approval, and accepts no idempotency key for these operations.

```sh
sdp members list [--page NUMBER] [--page-size NUMBER]
sdp members get-self
sdp members api-keys list <memberId>
sdp members update-role <memberId> --role admin|member|viewer
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp members remove <memberId> [--idempotency-key KEY]
sdp members leave-organization
sdp invitations create --email ADDRESS --role admin|member|viewer
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp invitations revoke <invitationId> [--idempotency-key KEY]
```

Every member and invitation command requires `SDP_TOKEN` for the active organization. The organization comes from the session; `--organization` does not switch it. Inviting, changing a role, removing a member, and revoking an invitation also require `--project` or `SDP_PROJECT_ID`, because those API operations scope idempotency to a project. Reads and leaving work without any project access, even when an old project selection is present in the environment.

```sh
pnpm cli members list --page 1 --page-size 25
pnpm cli members get-self
pnpm cli invitations create --project prj_example --email dev@example.com --role viewer \
  --idempotency-key invite-dev-1
pnpm cli members update-role mem_example --project prj_example --role member
pnpm cli invitations revoke inv_example --project prj_example
```

Member listing returns active members followed by pending invitations in one paginated directory, with pagination and the organization-wide admin count in `data.meta`. Pages are 1-based; `--page-size` accepts 1–100. Pending invitations are visible only to callers with `members.manage`. Use this directory to obtain membership and invitation IDs; there is no separate invitation-list endpoint.

`members api-keys list` requires a Clerk session with `members.manage` and reads the member's active API keys across the organization without a project header. It returns safe key and project metadata. Removing a member leaves organization-owned keys working; the CLI does not revoke them automatically.

Invitations reach the invitee through Clerk's emailed link and expire after seven days. The API never returns that acceptance link, and acceptance takes place through Clerk. Creation returns the invitation summary and can return its Clerk invitation ID. There is no SDP invitation-accept endpoint. Re-inviting an address that already has a pending invitation returns 409.

Role changes and removals operate on membership IDs, rather than user IDs. The server enforces self-edit and last-admin rules. `members leave-organization` uses the caller's own membership; an admin receives 409 and must be removed by another admin. `members remove me` is rejected locally to prevent accidentally invoking the separate leave route. Removal, leaving, and revocation return HTTP 204 and print nothing on success.

The four project-scoped mutations accept `--idempotency-key`. Reuse the same project, key, and request when explicitly retrying one logical operation. Keys remain optional for these endpoints, and the CLI never retries automatically. `members leave-organization` does not accept an idempotency key. These commands use the existing internal API and do not publish members or invitations in public OpenAPI or AI resources.

```sh
sdp api-keys list
sdp api-keys get <keyId>
sdp api-keys create --name NAME --grant ACTION --wallet-scope all|selected
    [--description TEXT] [--wallet-id ID] [--allowed-ip IP_OR_CIDR]
    [--expires-at ISO_TIMESTAMP] [--data JSON|@file.json|-]
sdp api-keys update <keyId> [--name NAME] [--description TEXT]
    [--grant ACTION] [--wallet-scope all|selected] [--wallet-id ID]
    [--allowed-ip IP_OR_CIDR] [--expires-at ISO_TIMESTAMP]
    [--clear-description] [--clear-allowed-ips] [--clear-expiration]
    [--clear-grants] [--data JSON|@file.json|-]
sdp api-keys rotate <keyId> [--grace-period-hours NUMBER] [--data JSON|@file.json|-]
sdp api-keys revoke <keyId> --confirmation EXACT_KEY_NAME
    [--cancel-recurring-payments] [--data JSON|@file.json|-]
```

Every API-key command requires `SDP_TOKEN` and `--project` or `SDP_PROJECT_ID`; an API key cannot administer keys. Listing and individual operations use the selected project. Use the key record's `id` from the list in commands that take `<keyId>`. `api-keys create` uses the same grant and wallet-scope fields as `projects api-keys create`, with the project selected through the header instead of a path argument. All six routes remain internal.

Creation requires explicit grants and a wallet scope. Use `--data` instead of individual body flags, including for an empty grant array. Repeated grant, wallet, and allowlist flags build arrays; updating those arrays replaces their current values. Omitted update fields remain unchanged. `--clear-grants` sends `grants: []`; `--clear-description`, `--clear-allowed-ips`, and `--clear-expiration` send `null` for their corresponding fields. For keys, `--clear-allowed-ips` removes the key's allowlist by setting `allowedIps: null`; the organization command instead sets its allowlist to an empty array. The API enforces grant eligibility, wallet membership, and IP/CIDR validity.

Rotation defaults to the server's 24-hour grace period when no value is supplied; the CLI sends an empty JSON object. `--grace-period-hours` accepts values from 0 through 168, including fractional hours, and preserves zero for immediate invalidation. The response contains the replacement's one-time secret and `previousKey.rotationDeadline`. Save that response securely. An already-rotated key returns a conflict naming the existing replacement; the CLI does not mint another key or retry automatically.

Revocation requires `--confirmation` with the exact key name, or the corresponding `confirmation` field in JSON input. It deactivates the key immediately. Recurring payments continue unless `--cancel-recurring-payments` is supplied. The HTTP 200 JSON result includes `recurringPayments.canceled` and `recurringPayments.failed` when cancellation was requested, or `null` otherwise. The key is revoked even if some recurring cancellations fail; inspect the returned IDs and cancel failed schedules individually.

```sh
pnpm cli api-keys list --project prj_example
pnpm cli api-keys create --project prj_example --name "Automation" \
  --grant wallets.read --wallet-scope selected
pnpm cli api-keys update key_example --project prj_example --clear-expiration
pnpm cli api-keys rotate key_example --project prj_example --grace-period-hours 0
pnpm cli api-keys revoke key_example --project prj_example --confirmation "Automation"
```

The API-key lifecycle endpoints do not offer idempotency keys. Creation and rotation return secrets once, and every command makes a single request without automatic retries. The CLI never stores the returned key as a credential or prints it on stderr.

```sh
sdp wallets managed-signing initialize-with-wallet --provider PROVIDER [--wallet-label LABEL]
    [--request-delay-ms NUMBER] [--network NETWORK] [--account-policy UUID]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp wallets create (--provider PROVIDER | --connection-id CONNECTION_ID)
    [--label LABEL] [--purpose PURPOSE] [--data JSON|@file.json|-]
    [--idempotency-key KEY]
sdp wallets list [--provider PROVIDER] [--include-balances] [--view summary]
sdp wallets get <walletId> [--include-balance true|false]
sdp wallets update <walletId> [--label LABEL | --clear-label]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp wallets delete --wallet-id WALLET_ID [--provider PROVIDER]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp wallets managed-signing configurations list
sdp wallets balances aggregate [--provider PROVIDER]
sdp wallets public-key get --wallet-id WALLET_ID
sdp wallets signer check --wallet-id WALLET_ID
    [--data JSON|@file.json|-] [--idempotency-key KEY]
```

Session calls require `--project` or `SDP_PROJECT_ID` for every wallet command. API keys use their bound project and explicit wallet grants. `wallets managed-signing initialize-with-wallet` requires a Clerk session with `wallets.configure`; API keys cannot initialize signing. The server enforces provider availability, entitlement, custody mode, and wallet scope.

Wallet commands take the provider's `walletId` returned by `wallets list`. The `id` field is the SDP wallet record ID used by API-key wallet scopes; the public key is the wallet's address. Pass `--wallet-id` exactly once for a wallet operation.

Creation selects exactly one owner: `--provider` uses the project's existing Managed signing configuration, while `--connection-id` uses a BYOK Custody Connection. Production projects require BYOK. Initialization creates a Managed configuration and its first wallet using credentials already configured on the deployment. Its optional settings depend on the provider; `--help` describes the operation and the API validates each provider's allowed fields. Client-supplied provider credentials are rejected. Creation purposes are `transfer`, `mint_authority`, `freeze_authority`, and `fee_payer`; omitting the purpose leaves the server's default of `transfer` in effect.

```sh
pnpm cli wallets list --include-balances
pnpm cli wallets get provider_wallet_id --include-balance false
pnpm cli wallets create --connection-id cconn_example --label "Treasury"
pnpm cli wallets update provider_wallet_id --clear-label
pnpm cli wallets public-key get --wallet-id provider_wallet_id
pnpm cli wallets signer check --wallet-id provider_wallet_id
```

Listing requests balances only when `--include-balances` is supplied. Individual reads include balances by default on the server; `--include-balance false` requests metadata without balance RPC calls. Public-key lookup reads the persisted address. Balance amounts remain exact strings in JSON, and omitted balances remain omitted. Aggregate returns 503 if a wallet balance cannot be read, preserving the server's refusal to return an incomplete total.

Updates change the label; `--clear-label` sends `null`. Empty updates are rejected locally. Deletion sends a JSON body containing `walletId` and, optionally, a provider consistency assertion; the provider must support deletion. Signer check signs a server-authored memo, verifies it, and simulates the transaction. It does not broadcast a transaction or spend sponsorship, and callers cannot supply memo text.

The five wallet mutations accept optional idempotency keys, and the CLI sends one request without automatic retries. A wallet-create failure can occur after provider provisioning: before retrying an ambiguous failure, inspect the wallet list and provider account. Provider deduplication and recorded-wallet recovery depend on the provider, credential, and key window; the generated `wallets create --help` includes the API's full recovery guidance.

```sh
sdp counterparties field-options get
sdp counterparties list [--page NUMBER] [--page-size NUMBER] [--include-archived]
sdp counterparties get <counterpartyId>
sdp counterparties create --entity-type individual|business --display-name NAME
    [--external-id ID] [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp counterparties update <counterpartyId> [--entity-type individual|business]
    [--display-name NAME] [--external-id ID | --clear-external-id]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp counterparties archive <counterpartyId> [--idempotency-key KEY]
sdp counterparties ramp-requirements get <counterpartyId> --provider PROVIDER
    --direction onramp|offramp --asset-rail RAIL --fiat-currency CODE
    [--destination-custody-wallet-id SDP_WALLET_RECORD_ID]
sdp counterparties ramp-requirements check <counterpartyId> --provider PROVIDER
    --direction onramp|offramp [--data JSON|@file.json|-]
sdp counterparties provider-accounts list <counterpartyId> [--provider PROVIDER]
    [--fiat-currency CODE] [--destination-country CODE]
sdp counterparties project-accounts list [--type crypto_account]
    [--page NUMBER] [--page-size NUMBER] [--search TEXT] [--ids ID,ID]
sdp counterparties accounts list <counterpartyId> [--account-kind crypto_wallet]
    [--page NUMBER] [--page-size NUMBER] [--include-archived]
sdp counterparties accounts get <counterpartyId> <counterpartyAccountId>
sdp counterparties accounts create <counterpartyId> --account-kind crypto_wallet
    --details JSON [--label LABEL] [--provider-account-data JSON]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp counterparties accounts update <counterpartyId> <counterpartyAccountId>
    [--label LABEL | --clear-label] [--details JSON] [--provider-account-data JSON]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp counterparties accounts archive <counterpartyId> <counterpartyAccountId>
    [--idempotency-key KEY]
```

All counterparty and account commands accept API keys with the required grants, or a Clerk session with `--project` / `SDP_PROJECT_ID`. Reads use `counterparties.read`; creating, updating, and archiving counterparties and archiving accounts use `counterparties.manage`. Creating and updating accounts require `counterparties.execute` because they set payment destinations. Requirements submission also uses `counterparties.execute`.

Counterparty creation requires an entity type and display name. `--external-id` stores an opaque cross-system reference; `--clear-external-id` clears it on update. `field-options get` returns current entity-type options and countries. Lists use server defaults of page 1 and 20 items per page; `--page-size` accepts 1–100. Each invocation returns one page and its metadata. Archiving hides the record from default lists; archives return HTTP 204 and print nothing.

Accounts belong to a counterparty, so account commands take both IDs when selecting an existing account. The supported kind is `crypto_wallet`; `--details` supplies a JSON object containing `network: "solana"` and a valid Solana `address`. The server validates the address. Updating details replaces the complete object, so send both fields. Provider metadata is also supplied as a complete JSON object with `--provider-account-data`; `{}` explicitly clears it. `--clear-label` sends `label: null`. Empty patches are rejected locally. For complete request bodies, use `--data` in place of individual body flags.

```sh
pnpm cli counterparties create --entity-type business --display-name "Supplier 42" \
  --external-id supplier_42 --idempotency-key supplier-create-1
pnpm cli counterparties accounts create cpty_example --data @wallet-account.json
pnpm cli counterparties accounts update cpty_example cpa_example --clear-label
pnpm cli counterparties accounts list cpty_example --include-archived
pnpm cli counterparties project-accounts list --search "Supplier" --page-size 25
```

`project-accounts list` returns recipient summaries across the selected project. Its search matches counterparty display names. `--ids` sends comma-separated account IDs; the server resolves those IDs without pagination and returns the original page fields. `provider-accounts list` returns separate provider-owned accounts and customer links. Provider references, decimal-string balances, and explicit balance unavailability are preserved when present; the CLI does not calculate balances or add provider calls.

Requirements evaluation needs a ramp provider, direction, crypto asset rail (for example `usdc.solana`), and uppercase fiat currency. Onramps require `--destination-custody-wallet-id` using the SDP wallet record's `id`; omit it for offramps. The server validates direction-specific provider and wallet rules and enforces release-channel and provider access. The CLI returns `ready`, `collect`, or `unsupported` with the complete fields or reason. It does not poll or open hosted flows automatically.

`ramp-requirements check` uses the existing internal POST operation, which accepts only provider and direction and evaluates stored provider data. It does not accept collected identity or bank fields. That operation and `project-accounts list` remain absent from public OpenAPI and AI resources. Requirements submission does not accept an idempotency key. Counterparty and account create, update, and archive commands accept optional idempotency keys; every command makes a single request without automatic retries.

```sh
sdp transfers execute --source-custody-wallet-id SDP_WALLET_ID --destination ADDRESS
    --asset SYMBOL_OR_MINT --amount DECIMAL --idempotency-key KEY
    [--memo TEXT] [--transfer-id EXISTING_OFFRAMP_TRANSFER_ID]
    [--data JSON|@file.json|-]
sdp transfers list [--custody-wallet-id SDP_WALLET_ID] [--asset SYMBOL_OR_MINT]
    [--search TEXT] [--direction inbound|outbound] [--status STATUS,STATUS]
    [--category wallet|ramp] [--type TYPE,TYPE] [--counterparty-id ID]
    [--provider PROVIDER] [--provider-reference REFERENCE]
    [--from ISO_TIMESTAMP] [--to ISO_TIMESTAMP] [--include-observed true|false]
    [--sort-by createdAt|updatedAt|amount|status] [--sort-direction asc|desc]
    [--page NUMBER] [--page-size NUMBER]
sdp transfers get <transferId>
sdp transfer-batches estimate --source-custody-wallet-id SDP_WALLET_ID
    --asset SYMBOL_OR_MINT --recipients JSON_ARRAY [--external-id ID]
    [--options JSON] [--data JSON|@file.json|-]
sdp transfer-batches execute --source-custody-wallet-id SDP_WALLET_ID
    --asset SYMBOL_OR_MINT --recipients JSON_ARRAY --idempotency-key KEY
    --external-id ID [--options JSON] [--data JSON|@file.json|-]
sdp transfer-batches list [--source-custody-wallet-id SDP_WALLET_ID]
    [--asset SYMBOL_OR_MINT] [--status STATUS] [--external-id ID]
    [--page NUMBER] [--page-size NUMBER]
sdp transfer-batches get <batchId>
sdp transfer-batches retry <batchId> --idempotency-key KEY
```

Use `--asset` for the payment token symbol or SPL mint address; `--token` remains the global Clerk credential flag. These commands select exact SDP wallet record IDs (`id` from `wallets list`). API keys use their bound project; Clerk calls require `--project` / `SDP_PROJECT_ID`. Transfer reads require `transfers.read` and creation requires `transfers.execute`. Batch estimate, list, and detail require `transfer_batches.read`; batch creation requires `transfer_batches.execute`. The API enforces wallet access and requests signing through the connected provider. The CLI makes no direct provider or Solana RPC calls.

Transfer amounts and recipient amounts are decimal strings in token UI units. The CLI preserves them without floating-point conversion. The server validates positive amounts, token precision, Solana addresses, balances, and wallet eligibility. `--transfer-id` funds an existing awaiting-payment off-ramp record through the same transfer endpoint; it still requires an idempotency key. If needed, an optional JSON `projectId` asserts the body project matches the request context. `--project` selects the session's request context and does not add a body field. Use `--data` instead of individual body flags for complete requests.

```sh
pnpm cli transfers list --custody-wallet-id cwlt_example --page-size 25
pnpm cli transfers get xfr_example
pnpm cli transfer-batches estimate --data @batch.json
pnpm cli transfer-batches execute --data @batch.json --idempotency-key payroll-42
pnpm cli transfer-batches get xbatch_example
```

Batch execution requires an explicit `externalId` for the batch; reusing it is a server conflict, not a second send. Estimate responses preserve their rent warnings. `transfer-batches retry` is an explicit bodyless POST that requires a caller-chosen idempotency key and resends only the server-selected failed recipients. Pending and processing recipients are never selected by the CLI, and conflicts do not cause an automatic retry.

A batch request has 1–500 recipients, each with a `counterpartyAccountId` and string `amount`; optional `counterpartyId` asserts its parent, and optional recipient `externalId` provides correlation. `--recipients` accepts an inline JSON array; for files and stdin, supply the complete request with `--data`. `--options` accepts a JSON object with optional `maxRecipientsPerTransaction` (1–64), `priorityFee` (`none`, `low`, `medium`, `high`, or `auto`), and boolean `preflight`. Omitted options remain omitted, and explicit `false` is preserved. Batch `externalId` is a correlation value, separate from idempotency.

```json
{
  "externalId": "payroll_42",
  "sourceCustodyWalletId": "cwlt_example",
  "token": "SOL",
  "externalId": "payroll_42",
  "recipients": [
    { "counterpartyAccountId": "cpa_example", "amount": "1.25" }
  ],
  "options": { "maxRecipientsPerTransaction": 20, "preflight": true }
}
```

Estimation returns transaction counts and string-valued fee components without executing the batch. It does not accept an idempotency key. Transfer and batch creation require a caller-supplied key, including with JSON input; omission fails before any HTTP request. Every command sends one request without automatic retries or polling. When explicitly repeating the same logical request, retain its key and payload. A changed payload under that key is refused by the server. After a timeout or an ambiguous outcome, inspect the existing transfer or batch before attempting another submission; changing the key can create a separate payment. Recipient order is preserved on the wire; the server's canonicalization determines batch idempotency.

A valid HTTP 200 response exits successfully even when a transfer is `processing` or a batch is `partially_failed`. Inspect the returned state, recipient errors, and chunk transfers. A nullable signature or Fireblocks transaction ID can mean submission is still being reconciled or waiting for provider approval. Read the existing record to follow its outcome. Amount strings, nullable fields, provider evidence, and recipient/chunk arrays remain intact in JSON output.

Lists return one page in `data` with `total`, `page`, `pageSize`, and `hasMore` in `meta`. Transfer lists support comma-separated status and type filters; batch lists accept one status. Exact provider-reference lookups also require a provider. Persisted transfer history is the default. `--include-observed true` opts into address history for `--custody-wallet-id`; observed rows can have `custodyWalletId: null`. The CLI forwards the filter without making its own history calls or fetching more pages. The server checks filter combinations and release-channel access.

```sh
sdp payment-requests create --wallet-id PROVIDER_WALLET_ID --asset TOKEN_MINT
    --amount DECIMAL [--expires-at UTC_TIMESTAMP] [--data JSON|@file.json|-]
sdp payment-requests list [--status awaiting_payment|paid|canceled|expired]
    [--page NUMBER] [--page-size NUMBER]
sdp payment-requests get <paymentRequestId>
sdp payment-requests cancel <paymentRequestId> [--idempotency-key KEY]
sdp payment-requests link-token get <paymentRequestId>
sdp payment-links get <publicToken>
sdp payment-links metadata get <publicToken>
sdp payment-links transactions build-sponsored-transaction <publicToken> --account PAYER_ADDRESS
    [--data JSON|@file.json|-]
```

Payment-request creation and link retrieval require `payment_requests.manage`; listing and detail require `payment_requests.read`. Use an API key or a Clerk session with `--project` / `SDP_PROJECT_ID`. Creation takes the provider's `walletId` from `wallets list`, and `--asset` must be a Solana token mint address. The transfers family's SDP wallet record selector and token-symbol support differ from this endpoint. Amounts remain exact decimal strings. Omitted expiration uses the server's default of no expiry; JSON `expiresAt: null` explicitly selects no expiry. Use `--data` instead of body flags for complete JSON requests.

Creation returns the record directly in `data`, including its bearer `publicToken`. Listing returns `data.paymentRequests` and pagination fields inside `data`; detail reads include lifecycle and fulfillment information. Those read responses omit link tokens. `payment-requests link-token get` retrieves `id` and `publicToken` through the manage-level operation. The CLI prints these tokens to stdout, keeps no local copy, and does not offer an idempotency key for secret-returning creation. Every call makes one request without automatic retries; if creation's outcome is uncertain, inspect existing requests before creating another.

```sh
pnpm cli payment-requests create --data @payment-request.json
pnpm cli payment-requests list --status awaiting_payment --page-size 25
pnpm cli payment-requests get preq_example
pnpm cli payment-requests link-token get preq_example
pnpm cli payment-links get LINK_TOKEN
pnpm cli payment-links metadata get LINK_TOKEN
pnpm cli payment-links transactions build-sponsored-transaction LINK_TOKEN --account PAYER_ADDRESS
```

`payment-requests cancel` requires `payment_requests.manage` and makes one bodyless POST, with an optional caller idempotency key. A paid, expired, or still-payable sponsored transaction can make cancellation fail with 409. The CLI preserves `canceledAt`, `canceledByApiKeyId`, `canceledByUserId`, and `paidLate`; it does not assume cancellation prevents a payment signed earlier from landing.

Payment-link commands use the positional bearer token. They work without `SDP_API_KEY` or `SDP_TOKEN`; account credentials and tenant selectors are ignored and never sent to `/pay`. API URL and timeout settings still apply. `get` returns the stored network, amount, status, and Solana Pay URL; the URL can be `null` when the request cannot be paid. `metadata` returns the label and icon without checking whether the token names a live request. These operations return bare JSON objects, which the CLI preserves without adding an envelope.

`transactions build-sponsored-transaction` posts only the payer's `account` and returns `transaction` and `message`. The transaction has the sponsor's signature and still requires the payer's signature and submission through their wallet flow. This command does not sign as the payer or broadcast. The server owns reconciliation and the sponsorship claim; another payer's live claim can return 429 with `Retry-After`. The CLI does not retry, poll, or accept an idempotency key for preparation. Bearer tokens are redacted from error messages, codes, and request IDs. These existing endpoints are described only in the internal OpenAPI document; public API reference and AI resources remain governed by the publication policy.

```sh
sdp recurring-payments create --source-custody-wallet-id SDP_WALLET_ID
    --counterparty-id ID --counterparty-account-id ID --asset SYMBOL_OR_MINT
    --amount DECIMAL --period-hours HOURS --idempotency-key KEY
    [--first-collection-at ISO_TIMESTAMP] [--metadata-uri URL] [--data JSON|@file.json|-]
sdp recurring-payments list [--counterparty-id ID] [--status STATUS]
    [--page NUMBER] [--page-size NUMBER]
sdp recurring-payments get <id>
sdp recurring-payments update <id> --idempotency-key KEY
    [--source-custody-wallet-id SDP_WALLET_ID] [--counterparty-id ID]
    [--counterparty-account-id ID] [--asset SYMBOL_OR_MINT] [--amount DECIMAL]
    [--period-hours HOURS] [--first-collection-at ISO_TIMESTAMP]
    [--next-collection-due-at ISO_TIMESTAMP] [--metadata-uri URL]
    [--clear-first-collection-at] [--clear-next-collection-due-at]
    [--clear-metadata-uri] [--data JSON|@file.json|-]
sdp recurring-payments activate <id> --idempotency-key KEY
sdp recurring-payments cancel <id> --idempotency-key KEY
sdp recurring-payments collect <id> --idempotency-key KEY
sdp recurring-payments resume <id> --idempotency-key KEY
```

Recurring-payment source selection uses the SDP wallet record's `id`. The destination is a counterparty crypto-wallet account. Amounts stay decimal strings, billing periods are whole hours from 1–8760, and the server accepts eligible USD stablecoins or project-issued tokens rather than native SOL. A first-collection override must be in the future. Creation stores a pending intent; activation creates and authorizes its on-chain subscription through the connected provider. `collect` starts a due collection and returns the recurring record, collection attempt, and payment transfer. A processing transfer is still awaiting reconciliation.

All six recurring mutations require an idempotency key. Creation and cancellation require `recurring.manage`; updates, activation, collection, and resume require `recurring.execute`. Reads require `recurring.read`. Active term, wallet, destination, or token edits can create a replacement subscription and cancel the previous one. Metadata and due-date edits follow the API's in-place behavior. Read the record after an uncertain edit before another submission. Cancellation stops future collections; an already processing collection may settle. The server owns lifecycle transitions and recovery; the CLI sends one request without automatic retries or polling.

Recurring-payment responses retain `pausedReason`, including custody-policy refusals and collection failures. The CLI does not resume a paused payment automatically or replace the server's reason.

Updates send only supplied fields. A change to `counterpartyId` also needs `counterpartyAccountId`. The clearing flags send explicit nulls for the pending first-collection override, active next-due timestamp, or metadata URI. Use a value or its clearing flag, and use complete JSON instead of individual body flags. Empty updates are rejected. Lifecycle commands use bodyless POSTs.

```sh
sdp subscription-plans create-record --owner-wallet-id PROVIDER_WALLET_ID
    --asset SYMBOL_OR_MINT --amount DECIMAL --period-hours HOURS
    [--program-plan-id U64_STRING] [--plan-pda ADDRESS]
    [--destination-address ADDRESS] [--puller-wallet-id PROVIDER_WALLET_ID]
    [--metadata-uri URL] [--status STATUS] [--data JSON|@file.json|-]
    [--idempotency-key KEY]
sdp subscription-plans list [--status STATUS] [--page NUMBER] [--page-size NUMBER]
sdp subscription-plans get <planId>
sdp subscription-plans update <planId> [--plan-pda ADDRESS]
    [--destination-address ADDRESS] [--puller-wallet-id PROVIDER_WALLET_ID]
    [--metadata-uri URL] [--status STATUS] [--clear-plan-pda]
    [--clear-destination-address] [--clear-puller-wallet-id] [--clear-metadata-uri]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp subscription-plans create build-unsigned-transaction <planId> [--destinations JSON_ARRAY]
    [--pullers JSON_ARRAY] [--end-ts U64_STRING] [--metadata-uri URL]
    [--data JSON|@file.json|-]
sdp subscriptions create-record --plan-id ID --counterparty-id ID --subscriber-address ADDRESS
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp subscriptions list [--plan-id ID] [--counterparty-id ID] [--status STATUS]
    [--due-before ISO_TIMESTAMP] [--page NUMBER] [--page-size NUMBER]
sdp subscriptions get <subscriptionId>
sdp subscriptions authorize build-unsigned-transaction <subscriptionId> --subscriber-token-account ADDRESS
    --expected-plan-created-at U64_STRING --expected-subscription-authority-init-id I64_STRING
    [--data JSON|@file.json|-]
sdp subscriptions cancel build-unsigned-transaction <subscriptionId> [--data JSON|@file.json|-]
sdp subscriptions resume build-unsigned-transaction <subscriptionId> [--data JSON|@file.json|-]
sdp subscriptions collect build-unsigned-transaction <subscriptionId> --receiver-token-account ADDRESS
    [--data JSON|@file.json|-]
sdp subscriptions collection-attempts list <subscriptionId> [--status STATUS]
    [--page NUMBER] [--page-size NUMBER]
```

Plan ownership and optional collector selection use provider wallet IDs. Plan creation stores an SDP record; `create build-unsigned-transaction` derives and stores its PDA and returns an unsigned transaction. Creation defaults remain server-owned. Plan updates accept mutable addresses, metadata, collector, and status; clearing flags send null. Creating a subscription stores a pending record with its plan, counterparty, and subscriber address. On-chain proof, lifecycle, and scheduling fields remain server-owned.

All `build-unsigned-transaction` commands return `preparedTransaction` with serialized bytes, blockhash, last-valid block height, and required signer addresses. The caller must arrange the required signatures and submit the transaction through their wallet flow. These commands do not broadcast or accept idempotency keys. Empty optional prepare bodies are sent as `{}`; explicit empty destination or puller arrays remain `[]`. The API allows at most four destinations and four pullers. Collection preparation takes only the receiver token account; its amount comes from the stored plan.

Program plan IDs, end timestamps, and authorization consent values stay decimal strings, including values larger than JavaScript's safe integer range. Consent includes the on-chain plan's unsigned `createdAt` and the authority's signed init ID. Use `--expected-subscription-authority-init-id=-1` for a negative value, or JSON string input. The API validates integer bounds, addresses, consent, token precision, and eligibility; the CLI performs no amount arithmetic or direct RPC calls.

Plan creation, plan preparation, subscription creation, and cancellation preparation require `recurring.manage`. Plan updates and authorization, collection, and resume preparation require `recurring.execute`. Plan/subscription creation and plan updates accept optional idempotency keys. All calls use an API key or a Clerk session with a selected project. Lists return one page, with their records and pagination fields inside `data`; each family's status filter follows its own generated API schema.

```sh
pnpm cli recurring-payments create --data @schedule.json --idempotency-key schedule-42
pnpm cli recurring-payments activate prp_example --idempotency-key activate-42
pnpm cli recurring-payments collect prp_example --idempotency-key collection-42
pnpm cli subscription-plans create build-unsigned-transaction psp_example --data @plan-overrides.json
pnpm cli subscriptions authorize build-unsigned-transaction psub_example --data @authorization.json
pnpm cli subscriptions collection-attempts list psub_example --page-size 25
```

```sh
sdp onramps supported-pairs list [--source FIAT_CODE] [--dest CRYPTO_RAIL] [--provider PROVIDER]
sdp offramps supported-pairs list [--source CRYPTO_RAIL] [--dest FIAT_CODE] [--provider PROVIDER]
sdp onramps estimate --asset-rail CRYPTO_RAIL --fiat-currency FIAT_CODE
    --fiat-amount DECIMAL [--data JSON|@file.json|-]
sdp offramps estimate --asset-rail CRYPTO_RAIL --fiat-currency FIAT_CODE
    --crypto-amount DECIMAL [--data JSON|@file.json|-]
sdp onramps start --provider PROVIDER --counterparty-id ID
    --destination-custody-wallet-id SDP_WALLET_ID --asset-rail CRYPTO_RAIL
    --fiat-currency FIAT_CODE --fiat-amount DECIMAL
    [--ramps-memo JSON_OBJECT] [--data JSON|@file.json|-]
sdp offramps start --provider PROVIDER --counterparty-id ID
    --source-custody-wallet-id SDP_WALLET_ID --asset-rail CRYPTO_RAIL
    --crypto-amount DECIMAL [--fiat-currency FIAT_CODE]
    [--ramps-memo JSON_OBJECT] [--data JSON|@file.json|-]
sdp ramps cancel --transfer-id ID [--data JSON|@file.json|-]
sdp ramps simulate-settlement --transfer-id ID [--data JSON|@file.json|-]
```

Currency support returns the server's pairs, provider details, country coverage, amount limits, and support hash. On-ramp selectors run from fiat to crypto; off-ramp selectors run from crypto to fiat. Use uppercase fiat codes such as `USD`, and crypto rails such as `usdc.solana`. Support and availability depend on the deployment, project entitlement, provider, and corridor; the server is authoritative.

Estimates make one request; the server evaluates eligible providers. The CLI preserves every `ok`, `unsupported`, and `error` result, including policy-refusal reasons and amount limits. Empty arrays and arrays containing only provider errors remain successful HTTP responses. Amounts, fees, and exchange rates remain exact decimal strings. Estimation has no provider selector; starting a flow selects one provider. No arithmetic or provider ranking is performed locally.

Starting a flow creates a provider checkout and an SDP transfer. Source and destination selectors use the SDP wallet record's `id` from `wallets list`. An omitted off-ramp fiat currency stays omitted; the existing MoonPay handler defaults it to USD. `--ramps-memo` accepts a JSON object of string values. Use complete JSON instead of body flags when supplying `--data`.

A quote response contains `quote` and `transferId`. Hosted URLs and Stripe widget session credentials are printed to stdout; save them securely. The CLI does not open checkouts, mount widgets, fund off-ramps, or treat quote creation as settlement. Follow the returned transfer with `transfers get`. If provider deposit instructions are available and you choose to fund an off-ramp, use the existing `transfers execute --transfer-id ID` flow explicitly. Current Stripe off-ramp creation is unsupported and returns an API error.

Cancellation returns the updated SDP transfer. Provider-side off-ramp sale cancellation is best-effort after SDP records cancellation; a canceled SDP record does not prove provider cleanup succeeded. Simulation sends only the transfer ID to the sandbox endpoint. Although its contract declares an empty 204 response, the current handler refuses simulation for the available providers; environment and state restrictions also apply.

Ramp operations accept an API key or a Clerk session with a selected project. Currency support and estimates require `onramp.read` or `offramp.read`; quotes require the direction's `execute` grant. Cancellation and simulation require `ramp_transfers.manage`. None accepts an idempotency key. Each call makes one request without automatic retries or polling. Read transfer state after an uncertain quote result before creating another checkout. Estimates, off-ramp starts, and cancellation remain internal OpenAPI entries; public publication is unchanged.

```sh
pnpm cli onramps supported-pairs list --source USD --dest usdc.solana
pnpm cli onramps estimate --asset-rail usdc.solana --fiat-currency USD --fiat-amount 100.00
pnpm cli onramps start --data @onramp-quote.json
pnpm cli offramps start --data @offramp-quote.json
pnpm cli transfers get xfr_example
pnpm cli ramps cancel --transfer-id xfr_example
```

```sh
sdp transactions list [--module MODULE] [--kind KIND] [--status STATUS]
    [--custody-wallet-id SDP_WALLET_ID] [--counterparty-id ID] [--asset TOKEN_VALUE]
    [--search PREFIX] [--from UTC_TIMESTAMP] [--to UTC_TIMESTAMP]
    [--cursor CURSOR] [--limit NUMBER]
```

Transaction history is the unified, project-scoped feed across modules. It requires `transactions.read`, plus each row's module read permission. Payments rows require the corresponding transfer, batch, recurring, payment-request, on-ramp, or off-ramp read grant. The server omits rows the caller cannot read and modules outside its release channel. Explicitly selecting a module or Payments kind without its permission returns 403. Use an API key or a Clerk session with `--project` / `SDP_PROJECT_ID`.

`--status` filters the normalized history status (`pending`, `succeeded`, `failed`, or `canceled`). Each row also retains its module-specific `moduleStatus` and `kind`; the server validates `--kind` against the selected `--module`. Wallet selection uses the SDP record's `id`. `--asset` passes the exact stored token value, usually a mint address, without resolving symbols. `--search` matches an ID or signature prefix rather than a substring. `--from` and `--to` map to inclusive `createdAtFrom` and `createdAtTo` UTC timestamp bounds.

Each invocation fetches one page and preserves `data.transactions`, `data.nextCursor`, and any response metadata. Pass `nextCursor` verbatim as `--cursor` with the same filters for the next page. A null cursor marks the end. The server defaults to 50 rows; `--limit` accepts 1–100. Amounts remain exact decimal strings or null, and wallet labels, signatures, and other nullable fields remain as returned. The CLI does not sort, aggregate, enrich, poll, or automatically retry the feed. Rate-limit and quota-backend failures remain API errors.

The feed uses its internal OpenAPI contract to accept every runtime module variant, including rows held out of public documentation. Public API and AI publication rules remain unchanged. There is no separate transaction-history detail endpoint; use the row's module-specific resource commands where available.

```sh
pnpm cli transactions list --limit 25
pnpm cli transactions list --module payments --kind onramp --status pending
pnpm cli transactions list --custody-wallet-id cwlt_example --from 2026-10-01T00:00:00Z
pnpm cli transactions list --limit 25 --cursor 'CURSOR_FROM_PREVIOUS_RESPONSE'
```

Earn commands are grouped by resource. Every operation supports `--help`; its positional IDs, action, project selection, and retry-key requirement come from the internal API contract.

| Command group                                                | Operations                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `earn strategies`                                            | `list`, `get`                                                                   |
| `earn treasury movements`                                    | `list`                                                                          |
| `earn portfolio-accounts`                                    | `list`, `create`, `get`, `allocation update`, `deposits list`                   |
| `earn portfolio-accounts withdrawals`                        | `preview`, `execute`, `list`, `get`                                             |
| `earn deposits`                                              | `preview`, `execute`, `build-unsigned-transaction`, `submit-signed-transaction` |
| `earn deposits provider-signed`                              | `list`, `get`                                                                   |
| `earn positions provider-signed`                             | `list`, `share-reconciliation-report get`                                       |
| `earn positions caller-signed`                               | `list`, `project-summary get`                                                   |
| `earn movements caller-signed`                               | `list`, `get`                                                                   |
| `earn earnings caller-signed`                                | `get`                                                                           |
| `earn withdrawals`                                           | `execute`, `build-unsigned-transaction`, `submit-signed-transaction`            |
| `earn withdrawals provider-signed` / `caller-signed`         | `preview`, `options get`; provider-signed also has `list`, `get`                |
| `earn withdrawal-requests`                                   | `execute`, `build-unsigned-transaction`, `submit-signed-transaction`            |
| `earn withdrawal-requests provider-signed` / `caller-signed` | `preview`, `list`, `get`                                                        |
| `earn withdrawal-requests cancel`                            | `execute`, `build-unsigned-transaction`, `submit-signed-transaction`            |

All Earn routes need an API key or a Clerk session with a selected project. The server enforces release channels, feature flags, entitlement, provider capability, custody-wallet scope, and exit rules. A catalogue row's `fundable`, slippage policies, or preview `blockingIssues` remain authoritative; the CLI does not select a provider or bypass a refusal. Earn remains held out of public API reference, Postman, playground, and AI artifacts. These commands use its existing authenticated internal OpenAPI contract.

Use `--data JSON|@file.json|-` for any body, instead of individual body flags. Amounts and shares are decimal strings. Deposit `--amount` is in the deposit token's units, or source-token units when `--source-token-mint` requests a swap. `--shares`, `--min-shares-out`, `--min-amount-out`, and `--intermediate-amount` keep their distinct units. Portfolio-account withdrawals use `--amount-usd` and `--asset usdc|usdt`. Allocation percentages are JSON numbers, for example `{"usdc":[{"yieldSourceId":"strategy_example","pct":100}]}`. The server validates allocation totals and eligibility.

Custody deposits take `--strategy-id` and `--custody-wallet-id`, the SDP wallet record's `id`. Custody withdrawals take `--position-id`; their stored position identifies the wallet and instrument. Call a preview and choose an explicit floor where the strategy requires it. The CLI does not calculate a tolerance, remove a floor, or automatically execute a preview. `earn positions provider-signed share-reconciliation-report get` reports differences without repairing them. `earn positions provider-signed list --after-movement-ids ID1,ID2` requests the API's confirmation-slot bound; unavailable values remain absent.

Custody deposits, withdrawals, queued requests, and cancellation require `--idempotency-key`. All caller-signed `submit-signed-transaction` operations require it too. Use a retry-stable UUIDv4 and the same payload for an uncertain logical operation; use a new key for a new intent. Body `requestId` is refused on these routes. Portfolio-account creation and withdrawal instead require exactly one UUIDv4 source: `--idempotency-key` or body `requestId` / `--request-id`. Portfolio-account allocation updates accepts either source optionally, never both. Builds, previews, options, and reads do not accept a key. Each invocation makes one request, with no automatic retry or polling; inspect the recorded resource after an uncertain outcome.

Caller-signed builds take an owner address for deposits and a tenant-scoped position ID for exits. They return unsigned transaction bytes, transaction IDs, and string block heights. Arrange signatures outside the CLI, then submit the exact signed bytes using `--transaction-id` and `--signed-transaction`, or preferably a JSON file or stdin. A partner `--fee-payer` must also sign. The explicit submit operation asks SDP to record and broadcast; the CLI does not sign or broadcast directly. A split-swap build returns `requiresSeparateSwap`, a swap transaction, and `followUp` terms. Those are preserved for the caller to handle; no swap or follow-up deposit runs automatically.

Asynchronous withdrawal options distinguish `solverQueue` from `operatorRedemption`. Solver terms include `--shares`, `--discount-bps` (zero is valid), and `--deadline-seconds`. Operator redemption requires its mechanism and exactly one of shares or intermediate amount, with no solver-only terms. A request transaction can escrow shares or convert them to an intermediate asset; it does not prove payout. Cancellation can recover shares or leave intermediate tokens. `closedOrUnknown` remains unresolved, and a confirmed provider-order movement remains pending settlement. Responses retain every lifecycle observation, signature, exact amount, and null without inferring completion.

Pagination follows each endpoint: strategy and portfolio-account lists use `--page` / `--page-size`; portfolio-account deposits use `--cursor`; movement, position, and queued-request feeds use `--limit` / `--before`. Forward the returned cursor verbatim with the same filters. `--settled false` is explicit and uses the API's provider-aware settlement boundary. `--request-id` on custody movement lists finds an uncertain operation by its original key. The cross-provider movement feed accepts recorded provider IDs, including retired ones, and excludes caller-signed rows; use `earn movements caller-signed list` with `--owner-address` for those.

Per-owner external position, movement, request, and earnings lists require `--owner-address`. Movement and request details use their scoped IDs. Project position summaries omit the owner's address book by default. `--include-owner-addresses true` explicitly opts in; `--include-positions true` also requires that owner opt-in. The CLI never adds it automatically.

```sh
pnpm cli earn strategies list --source-kind defi --page-size 10
pnpm cli earn deposits preview --strategy-id strategy_example --amount 25.00
pnpm cli earn deposits execute --data @deposit.json --idempotency-key UUIDV4
pnpm cli earn deposits provider-signed list --request-id UUIDV4 --settled false
pnpm cli earn withdrawals provider-signed options get --position-id position_example
pnpm cli earn withdrawal-requests execute --data @request.json --idempotency-key UUIDV4
pnpm cli earn deposits build-unsigned-transaction --data @build.json
pnpm cli earn deposits submit-signed-transaction --data @signed.json --idempotency-key UUIDV4
pnpm cli earn positions caller-signed project-summary get
pnpm cli earn portfolio-accounts allocation update program_example --data @allocation.json --idempotency-key UUIDV4
```

```sh
sdp dvp mints inspect <mint>
sdp dvp trades create --party-a JSON_OBJECT --party-b JSON_OBJECT
    --mint-a ADDRESS --mint-b ADDRESS --token-program-a ADDRESS --token-program-b ADDRESS
    --amount-a U64_STRING --amount-b U64_STRING --expiry-timestamp I64_SECONDS
    [--earliest-settlement-timestamp I64_SECONDS]
    [--user-a-settlement-destination ADDRESS] [--user-b-settlement-destination ADDRESS]
    [--ref-string REFERENCE] [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp dvp trades list [--status COMMA_SEPARATED_STATUSES]
    [--settlement-availability COMMA_SEPARATED_VALUES] [--search TEXT] [--limit NUMBER]
sdp dvp trades inbound list
sdp dvp trades get <tradeId>
sdp dvp trades fund <tradeId> --side a|b [--custody-wallet-id SDP_WALLET_ID]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp dvp trades reclaim <tradeId> --side a|b [--custody-wallet-id SDP_WALLET_ID]
    [--data JSON|@file.json|-] [--idempotency-key KEY]
sdp dvp trades settle <tradeId> [--idempotency-key KEY]
sdp dvp trades cancel <tradeId> [--idempotency-key KEY]
```

DvP uses authenticated internal contracts. The server enforces the Markets flag, release channel, project scope, custody-wallet scope, and devnet program availability. Use an API key or a Clerk session with a selected project. Reads require `dvp.read`; creation, reclaim, and cancel require `dvp.manage`; fund and settle require `dvp.execute`. Public DvP publication is unchanged.

Each party JSON object selects exactly one `walletId`, `counterpartyAccountId`, or `address`. Here `walletId` is the SDP wallet record's `id`. Fund/reclaim's `--custody-wallet-id` maps to that operation's optional `walletId`; it only narrows selection to a wallet holding the selected party address. Creating a trade records a proposal and escrows; it does not fund either leg. Verify the stored terms, both token programs, parties, and settlement destinations before choosing to fund. Reference strings are correlation hints.

Amounts are raw token base units as u64 integer strings. Expiry and earliest settlement are i64 Unix-second strings. Mint inspection reports the owning token program, decimals, inline metadata, eligibility, and blocking reason. Unknown precision remains null; RPC failure remains an error. The CLI performs no decimal conversion, nonce generation, direct RPC reads, or automatic funding. The API validates decoded addresses, integer ranges, and economic terms that OpenAPI cannot fully express. Use complete JSON instead of body flags for `--data`; nullable optional terms may be explicit null.

The API accepts an optional idempotency header on all five mutations. Supply a stable `--idempotency-key` when creating, funding, reclaiming, settling, or canceling a logical operation. Reuse it with the same terms only for an explicit retry of that operation; use a new key for a new intent. The CLI sends one request and never retries automatically. Creating without a key after an uncertain response can create a second trade, so read the recorded trade before another submission.

Funding accepts the side and optional wallet; the server determines the outstanding amount. Reclaim returns a leg's escrow to its own party while leaving the trade open. Settle and cancel are bodyless authority actions that close the trade: settlement delivers both legs, cancellation refunds them. An action response with `confirmed: false` remains unconfirmed; the CLI preserves it and does not poll or infer settlement.

Lists fetch the newest matching trades with server-side status, settlement-availability, and substring-search filters. `--limit` is 1–100; omitted uses the server's 25. This endpoint has no cursor or page parameter. Inbound discovery has no address selector and returns the API's restricted party view without adding creator attribution or private funding claims. Use the dedicated `inbound` command; `get inbound` is refused as a route collision.

DvP refusal reasons remain available at `error.details.reason`, including frozen or mismatched escrows, funding in flight, and close conflicts. Structured error details are preserved across the CLI, with account and bearer-link credentials redacted recursively. Null funding observations, unresolved closes, raw balances, nonces, signatures, and slot strings remain as supplied by the server.

```sh
pnpm cli dvp mints inspect MINT_ADDRESS
pnpm cli dvp trades create --data @trade.json --idempotency-key trade-42
pnpm cli dvp trades inbound list
pnpm cli dvp trades get dvp_example
pnpm cli dvp trades fund dvp_example --side a --custody-wallet-id cwlt_example --idempotency-key fund-42-a
pnpm cli dvp trades settle dvp_example --idempotency-key settle-42
```

Issuance commands expose token administration and transaction flows; asset-profile commands manage the accompanying asset description.

| Command group                                            | Operations                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `issuance templates`                                     | `list`, `get`                                                                                                   |
| `issuance tokens`                                        | `create`, `create-with-asset-profile`, `list`, `facets`, `get`, `update`, `metadata get`, `refresh-supply`      |
| `issuance transactions` / `issuance tokens transactions` | `list`                                                                                                          |
| `issuance tokens audit-history`                          | `list`                                                                                                          |
| `issuance tokens deploy`                                 | `execute`, `build-unsigned-transaction`, `confirm-submitted-transaction`, `metadata build-unsigned-transaction` |
| `issuance tokens mint` / `burn` / `seize` / `force-burn` | `execute`, `build-unsigned-transaction`                                                                         |
| `issuance tokens authority update`                       | `execute`, `build-unsigned-transaction`                                                                         |
| `issuance tokens`                                        | `pause`, `unpause`, `freeze-account`, `unfreeze-account`                                                        |
| `issuance tokens frozen-accounts`                        | `list`                                                                                                          |
| `issuance tokens control-list`                           | `list`, `labels list`, `add`, `remove`                                                                          |
| `issuance tokens holder-enrollments`                     | `list`, `create`                                                                                                |
| `asset-profiles`                                         | `field-options get`, `list`, `get`, `get-by-token`, `update`, `archive`                                         |

Use `--help` for each command's exact flags and action. Protected operations accept an API key or a Clerk session with a selected project. Creation and profile administration require `issuance.manage`; reads require `issuance.read`; deployment, ordinary mint/burn, token updates, and their preparations require `issuance.execute`. Enforcement operations (seize, force-burn, pause, freeze, allowlist writes) require `issuance.enforce`; authority changes require `issuance.authority`. The server enforces project scope, current authorities, key grants, feature flags, and provider eligibility.

`issuance tokens metadata get` is public and fetches the SDP-hosted metadata JSON directly, without account credentials or tenant headers, even if they are configured. It returns the server's bare JSON and public projection as supplied. It does not follow a token's external URI, read the private profile, or recompute public metadata. Draft and unknown token IDs return 404. All other token and profile commands require account authentication.

Token creation takes `--name`, `--symbol`, optional `--decimals`, `--template`, `--overrides JSON`, metadata URLs, and capability flags. `--requires-allowlist`, `--mintable`, and `--freezable` take explicit `true` or `false`; zero decimals and false values stay explicit. `--signing-custody-wallet-id` selects the exact SDP wallet record ID. It is a deployment selection on a draft and historical attribution after deployment, not proof of who currently controls a mint authority. Later operations resolve and authorize the current signer at the API. Use `--data JSON|@file.json|-` for a complete body instead of individual body flags. Updates send only supplied fields; JSON null clears nullable metadata or removes a supply cap. Empty updates are refused locally.

Mint, burn, seizure, and force-burn quantities use exact decimal strings in token UI units. The API applies token precision and converts to base units; the CLI performs no arithmetic. Nested requests are supplied with `--mint`, `--burn`, `--seize`, `--force-burn`, or `--authority` JSON, or a complete `--data` body. Transaction `--options` accepts the API's JSON options, preserving zero priority fees and `simulate: false`. Authority requests carry their own `role` and nullable `newAuthority`; an explicit null can irreversibly revoke an authority. No confirmation or revocation is inferred from other fields.

Executing deploy/mint/burn/enforcement/authority commands asks the API to use the connected signing provider and submit. `build-unsigned-transaction` commands return caller-signable transaction bytes and string block heights; they do not execute the transaction or arrange signatures. Legacy deploy preparation accepts `--signing-wallet-id`, a provider wallet ID, and pins it server-side. The caller signs and submits externally, then explicitly calls `deploy confirm-submitted-transaction` with `--signature` and `--mint-address`. A returned `metadataUriFollowUp` requires a separate caller-driven `deploy metadata build-unsigned-transaction` flow after confirmation. A null follow-up transaction means the URI already matches; it is preserved as null. The CLI never signs, submits prepared bytes, follows up automatically, or polls for completion.

Supply reads remain cached until an explicit `refresh-supply` request. Token lists support stored status, derived deployment status, template, search, creation bounds, and sort controls. Facets return the project-visible values, including historical template IDs. Lists fetch one page; token, audit, allowlist, and transaction feeds preserve the API's array-in-`data` pagination envelope. Page limits are operation-specific: tokens 100, token transactions and allowlists 500, holders 200. Cross-token issuance history accepts repeated `--type`, for example `--type burn --type force_burn`; single-token history accepts one type. Choose either `--custody-wallet-id` for participant history or legacy `--wallet-id`; the API rejects combining them. The wallet identifier is never silently converted.

Control-list commands accept exact wallet addresses and optional labels. Removal sends the selected signing custody wallet in its query, and a successful removal produces no stdout. Freeze and unfreeze use `--account-address`; freezes may also carry `--reason`. Holder enrollment takes `--wallet-address`, optional `--counterparty-id`, and `--review-mode auto|manual`. It records the API's KYC identity/enrollment state without performing verification or automatically changing transfer permissions.

`issuance tokens create-with-asset-profile` creates a token and its profile atomically through one API call. Category/type options come from `field-options`; the server validates supported pairs and settings. `--issuance-metadata` supplies the complete private master object and replaces it on update. The server derives `publicMetadata` and clamps `visibility.public` to supported public namespaces. The CLI does not publish private namespaces or accept a client-supplied `publicMetadata` create field. Profile lists support category, archived inclusion, and a comma-separated `--token-ids` selection. Archive is a separate DELETE of the profile, returns no content, and does not delete the token.

Replay headers are exposed only where the API declares them. Supply an explicit `--idempotency-key` for an intentional write where available; reuse it with the same payload only for an explicit retry of that intent. No key is generated. Preparations, public reads, profile writes, and other operations without that header reject the flag. Every invocation makes one request without automatic retry, polling, or a sequence of dependent writes. Inspect stored token/transaction state after an uncertain outcome.

```sh
pnpm cli issuance templates list
pnpm cli issuance tokens create --name "Example Asset" --symbol EXM --decimals 6 --template custom
pnpm cli issuance tokens get tok_example
pnpm cli issuance tokens metadata get tok_example
pnpm cli issuance tokens deploy execute tok_example --signing-custody-wallet-id cwlt_example --idempotency-key deploy-42
pnpm cli issuance tokens mint build-unsigned-transaction tok_example --mint '{"destination":"WALLET_ADDRESS","amount":"25.000001"}'
pnpm cli issuance transactions list --type burn --type force_burn --custody-wallet-id cwlt_example
pnpm cli asset-profiles field-options get
pnpm cli issuance tokens create-with-asset-profile --data @asset.json
pnpm cli asset-profiles update profile_example --issuance-metadata '{"asset":{"name":"Example Asset"},"visibility":{"public":[]}}'
```

## Private Channels

`private-channels` covers the existing internal, feature-gated API. The API's release channel and Private Channels feature flag must permit the family. These commands do not publish it as a public API or bypass its project, wallet, or action checks.

| Command                                                               | Operation                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `private-channels instance-connection get`                            | Read the active instance or null                     |
| `private-channels instance-connection connect`                        | Probe and connect the proposed configuration         |
| `private-channels instance-connection update`                         | Replace configuration for the exact `--instance-id`  |
| `private-channels instance-connection disconnect`                     | Disconnect while retaining configuration and history |
| `private-channels instance-connection delete`                         | Delete the active instance                           |
| `private-channels instance overview get`                              | Read gateway, RPC, deployment, and auth observations |
| `private-channels instance-connection probe` / `check-gateway-health` | Test candidate configuration / gateway health        |
| `private-channels balances get`                                       | Read one owner's channel balance                     |
| `private-channels token-eligibility list`                             | Read token eligibility and exclusion reasons         |
| `private-channels channels list/create/get/delete`                    | Manage logical channels                              |
| `private-channels channels transfer-recipients list CHANNEL_ID`       | List eligible recipient verified wallets             |
| `private-channels deposits execute/list/get`                          | Deposit and read deposit history                     |
| `private-channels withdrawals execute/list/get`                       | Burn channel balance and read withdrawal history     |
| `private-channels transfers execute CHANNEL_ID`                       | Transfer to an eligible verified wallet              |
| `private-channels transfers list/get`                                 | Read retained project transfer history               |
| `private-channels events list`                                        | Read one project activity page                       |
| `private-channels channels events list CHANNEL_ID`                    | Read one channel activity page                       |
| `private-channels events reference-labels list`                       | Read the event display-name dictionary               |
| `private-channels verified-wallets list/revoke`                       | List or revoke verified associations                 |
| `private-channels wallets verify`                                     | Verify a connected custody wallet                    |
| `private-channels principals list/create/disable`                     | Manage project business participants                 |
| `private-channels channels principal-memberships add/remove`          | Grant or remove channel membership                   |

Instance connect, update, disconnect, and deletion, principal creation and disabling, and membership changes require a Clerk session with `private_channels.configure` and a selected project. API keys cannot hold configure grants. Reads require `private_channels.read`; channel creation/deletion and wallet revocation require `private_channels.manage`; wallet verification and movements require `private_channels.execute`. The API enforces selected-wallet bindings. Principals represent business participants, separate from SDP members and invitations.

Connect and update accept `--gateway-url`, `--auth-url`, `--escrow-program-id`, `--withdraw-program-id`, and `--escrow-instance-addr`. Update also requires `--instance-id`. Deprecated `--chain-rpc-url` is a compatibility field; execution uses SDP's managed RPC. Reconnecting an inactive same-gateway row may return 409 with `requiresReactivateConfirmation`; an explicit `--confirm-reactivate true` on a later connect request acknowledges replacing its configuration. The CLI never infers this acknowledgement or follows up automatically. Probe accepts gateway/auth URLs and, optionally, both escrow deployment addresses. Health accepts `--gateway-url`. Degraded or unreachable observations can be valid HTTP 200 results; inspect their status and reasons.

Movement commands take one `--wallet-id`, an exact decimal-string `--amount` in token UI units (positive, at most six fractional digits), optional `--mint`, and a required caller-chosen `--idempotency-key`. Source wallets must be connected and verified for the required project principal; the server checks access and admission before signing. Deposit accepts `--recipient` (wallet ID or address); withdrawal accepts `--destination` (release address); transfer requires `--recipient-verified-wallet-id` from the channel's recipients response. This opaque ID differs from a pubkey, connected wallet ID, and principal ID. Omitting mint or destination leaves defaults to the server. `--data JSON|@file.json|-` replaces body flags.

The API signs and submits movements through the connected custody provider. Reuse the original key and identical body for a caller-driven retry of the same logical movement. The CLI makes one request, never signs locally, retries, or polls automatically. A submitted transfer has been accepted at ingress; confirmed means it executed. Withdrawal submission or confirmation does not prove the later release settled. Read the returned status, signature, settlement reference, and failure reason; use `get ID` explicitly to check again. History can remain readable after channel or instance changes; `transfers list --channel-id ID` narrows that history.

`wallets verify WALLET_ID` sends an empty object by default, or accepts `--principal-id`. The API signs a fresh SPC challenge on each request; no idempotency key is accepted. `verified-wallets revoke PUBKEY` takes a wallet public key. Principal disabling retains its row/history, revokes verified wallets, and removes channel memberships; the default principal cannot be disabled. `channels principals add CHANNEL_ID --principal-id PRINCIPAL_ID` returns the API's persisted membership row, including its snake-case field names. Removal takes `CHANNEL_ID PRINCIPAL_ID` positionally.

Event feeds accept `--family`, one exact `--type`, `--status`, `--limit` (1–100), and `--before` with the prior `nextCursor`. Each command fetches one page and preserves `hasMore` and `nextCursor`. Balance takes `--owner` and optional `--mint`; its raw `amount` and `uiAmount` remain strings without conversion.

```sh
pnpm cli private-channels --help
pnpm cli private-channels channels create --name Treasury
pnpm cli private-channels wallets verify cwlt_example --principal-id pcu_example
pnpm cli private-channels channels transfer-recipients list pch_example
pnpm cli private-channels transfers execute pch_example --wallet-id cwlt_example \
  --recipient-verified-wallet-id pcvw_recipient --amount 1.000001 --idempotency-key transfer-42
pnpm cli private-channels events list --family transfer --limit 100
```

## Helius Rings

`helius-rings` covers the existing internal API and its dashboard connection-management routes. The API's release channel, feature flag, project access, wallet bindings, and action grants still apply. This adds no routes to the public OpenAPI document.

| Command                                                       | Behavior                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `helius-rings health` / `setup-status`                        | Read component health / default connection readiness       |
| `helius-rings rings list/create`                              | List custom rings / run or resume signed bring-up          |
| `helius-rings wallets list/create/get`                        | List, provision, or inspect Rings wallets                  |
| `helius-rings wallets sync WALLET_ID`                         | Full Photon sync and current balance observations          |
| `helius-rings wallets identity get WALLET_ID`                 | Inspect derived, published, and recorded identity          |
| `helius-rings wallets identity rekey WALLET_ID`               | Explicit irreversible rotation of a foreign identity       |
| `helius-rings wallets zones list/create WALLET_ID`            | Read or create SDP-owned zone metadata                     |
| `helius-rings operations list/get`                            | Read summaries or an operation with its timeline           |
| `helius-rings operations execute`                             | Reserve an intent and run proving, signing, and submission |
| `helius-rings operations resume-execution OPERATION_ID`       | Resume an interrupted operation                            |
| `helius-rings operations retry OPERATION_ID`                  | Create and run a linked retry with a supplied nonce        |
| `helius-rings operations recheck-signed-failure OPERATION_ID` | Observe the indexer and update state if indexed            |
| `helius-rings operations void-signed-failure OPERATION_ID`    | Explicit reconciliation of an absent signed failure        |
| `helius-rings connections list/create`                        | List safe metadata / probe and store endpoints             |
| `helius-rings connections test CONNECTION_ID`                 | Probe a stored connection                                  |
| `helius-rings connections make-default CONNECTION_ID`         | Select an active connection as the project default         |
| `helius-rings connections deactivate CONNECTION_ID`           | Deactivate a non-default connection after reconciliation   |

Reads require `helius_rings.read`. Wallet provisioning, sync, zone creation, recheck, and void require `helius_rings.manage`. Custom-ring bring-up, rekey, operation creation, execution, and retry require `helius_rings.execute`. All five connection commands require a Clerk session for an organization administrator with `helius_rings.configure`; API keys cannot configure connections. Session calls require `--project` or `SDP_PROJECT_ID`.

`wallets provision-identity --custody-wallet-id ID --name NAME` resolves the connected custody wallet and provisions a shielded identity through its provider. Subsequent wallet paths and `operations execute --rings-wallet-id ID` use the returned Rings wallet `id` (`hrw_...`). That ID differs from the custody record ID and the returned provider `sdpWalletId`; the CLI never converts between them. Zones take `--name` and `--kind treasury|public` and do not sign transactions. Ring creation takes a lowercase `--name` slug and a pre-deployed `--ring-program-id`; `default` is reserved. Resubmitting the same name and program can resume failed bring-up.

Operation creation runs immediately; it does not return an unsigned preparation for the CLI to sign later. Supply `--op-type`, `--mint`, `--client-nonce`, and the fields the flow supports, or replace body flags with `--data JSON|@file.json|-`:

| `--op-type`                | Required terms beyond Rings wallet and nonce                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `shield`                   | Mint and `--amount-raw`; optional `--ring`                                                                   |
| `withdraw`                 | Runtime SOL/USDC mint, amount, and `--to` public destination; optional ring                                  |
| `transfer_registered`      | Runtime SOL/USDC mint, amount, and canonical same-tenant recipient shielded address in `--to`; optional ring |
| `merge`                    | Runtime SOL/USDC mint; no amount, recipient, or ring                                                         |
| `ring_exit` / `ring_entry` | SOL mint, amount, and a custom `--ring`; self-only movement between that ring and the default pool           |

`--amount-raw` is a positive u64 base-unit integer **string**, up to `18446744073709551615`. The CLI performs no unit conversion or arithmetic. The API checks range, asset admission, available notes, ring readiness, and per-flow restrictions; unsupported anonymous transfers and timelocks are rejected. `--client-nonce` is required (1–128 characters) and never generated. The server fingerprints intent terms and returns the existing row for a repeated intent. These endpoints do not support `--idempotency-key`.

A returned operation may still be proving, submitted, indexing, failed, or completed. An HTTP success does not imply completed indexing. Read `state`, `outerTxSignature`, `photonIndexedAt`, failure retryability, and `retryOfOperationId`; `get` includes the timeline. The API strips proof artifacts and does not retain the consumed nonce. Each CLI invocation makes one request. There is no automatic execute, retry, polling, recheck, or void. `retry --client-nonce VALUE` runs a new linked attempt while the server preserves the original pinned ring and applies retry rules. Recheck only observes presence; it never proves absence. `void-signed-failure --signature SIGNATURE` asserts absence and the server checks the original signature, age, and chain history before changing state.

An identity read can report `unregistered`, `ours`, or `foreign` without changing keys. `wallets identity rekey --confirmation EXACT_WALLET_NAME` explicitly acknowledges irreversible rotation and abandonment of notes encrypted to the old keys. The API verifies the identity and confirmation. A paused or mismatched wallet never triggers an automatic rekey.

Sync preserves separate balances for each ring, base-unit strings, unknown decimals, missing prices, and null `totalUsd`. When `degraded` is true its balances may be incomplete. Health's amber/red observations are valid responses. Wallet and operation lists accept `--limit` (1–200) and fetch one bounded list without additional detail requests.

```sh
pnpm cli helius-rings --help
pnpm cli helius-rings setup-status
pnpm cli helius-rings wallets provision-identity --custody-wallet-id cwlt_example --name Treasury
pnpm cli helius-rings wallets identity get hrw_example
pnpm cli helius-rings operations execute --data @shield.json
pnpm cli helius-rings operations get hrop_example
pnpm cli helius-rings connections create --data @connection.json
```

## Dashboard Rings setup

`helius-rings connections` covers all five setup routes under `/internal/dashboard/helius-rings/connections`. Use an organization administrator's Clerk session (`SDP_TOKEN` or `--token`) and select the project with `SDP_PROJECT_ID` or `--project`. The action is `helius_rings.configure`; API keys cannot perform setup.

```sh
pnpm cli helius-rings connections --help
pnpm cli helius-rings connections list
pnpm cli helius-rings connections create --data @connection.json
pnpm cli helius-rings connections test hrconn_example
pnpm cli helius-rings connections make-default hrconn_example
pnpm cli helius-rings connections deactivate hrconn_previous
```

The creation JSON requires `name`, `solanaRpcUrl`, `indexerUrl`, and `proverUrl`. `ringRpcUrl` and `allowInsecureHttp` are optional. The equivalent flags are `--name`, `--solana-rpc-url`, `--indexer-url`, `--prover-url`, `--ring-rpc-url`, and `--allow-insecure-http true|false`. Prefer a file or `--data -` with stdin to keep keyed URLs out of shell history. The CLI preserves omitted fields and explicit false values. Plain HTTP requires explicit opt-in and a development API environment.

Full endpoints are stored on the API. List, create, default selection, and deactivation return safe connection metadata with origin-only endpoint displays, nullable check results, and lifecycle status. The CLI rejects unexpected credential fields and endpoints containing paths, queries, fragments, or user information before writing stdout. API errors redact submitted endpoint URLs and their query credentials, including nested error details.

Creation probes the supplied endpoints, and the first active connection becomes default. Testing returns component observations; amber or red health is a valid result, and custom-ring health can be null. Select a replacement default explicitly before deactivation. The API refuses deactivation of the current default or a connection with unsettled pinned operations. Every invocation makes one request; these routes accept no idempotency key and trigger no automatic default switch, retry, or reconciliation.

## Dashboard network data

`network snapshot get` covers `GET /internal/dashboard/network`, the complete Dashboard network-data surface. It requires a signed-in user's Clerk session (`SDP_TOKEN` or `--token`); API keys are refused. No project selection or tenant action is required, and configured project and organization selectors are not sent. This route is documented only in internal OpenAPI.

```sh
pnpm cli network --help
pnpm cli network snapshot get
pnpm cli network snapshot get --compact
```

The response preserves the API envelope and its snapshot: `asOf`, `metrics`, and `health`. The four metric series are `stablecoinSupply`, `stablecoinTransfers`, `stablecoinShare` (percent of successful non-vote transactions), and `costPerTransaction` (USD). Each contains daily `{date, value}` points in the API's order. An empty series means unavailable; a zero value remains zero. `asOf` identifies the shared complete UTC day. Mainnet health has its own `state` and `checkedAt`, or is null when unavailable.

These are chain-wide mainnet figures, independent of a project's environment. The API owns source credentials and caching and can serve older readings with their original timestamps. The CLI prints those timestamps and values unchanged, makes one request, and performs no aggregation, source refresh, polling, or automatic retry. It accepts no date, network, or pagination filters, request body, or idempotency key. If the API cannot serve a snapshot, its 503 error is returned without invented readings.

## Webhook ingress

`webhooks` forwards signed deliveries to all three existing ingress routes. It uses captured provider signature headers, independently of SDP API keys and Clerk session tokens. Account credentials and tenant selectors are not sent. These routes remain internal in OpenAPI.

| Command                                      | Endpoint                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| `webhooks clerk deliver`                     | `POST /webhooks/clerk`                                |
| `webhooks ramps sandbox deliver PROVIDER`    | `POST /webhooks/payments/ramps/sandbox/{provider}`    |
| `webhooks ramps production deliver PROVIDER` | `POST /webhooks/payments/ramps/production/{provider}` |

```sh
pnpm cli webhooks --help
pnpm cli webhooks clerk deliver --body @clerk-event.json --headers @clerk-headers.json
pnpm cli webhooks ramps sandbox deliver stripe --body @stripe-event.json --headers @stripe-headers.json
pnpm cli webhooks ramps production deliver moonpay --body @moonpay-event.json --headers @moonpay-headers.json
cat stripe-event.json | pnpm cli webhooks ramps sandbox deliver stripe --body - --headers @stripe-headers.json
```

`--body` is required and accepts `@file` or `-` for stdin. The original bytes are forwarded without JSON parsing, normalization, or re-serialization, preserving whitespace, Unicode, numeric spelling, and duplicate keys covered by the signature. The body must contain 1–1,048,576 bytes. `--data` and individual event-field flags are unsupported.

`--headers` is required and accepts a JSON object, `@file`, or `-`. Prefer a file so signatures do not enter shell history. Include only the signature headers below, with their original string values; header names are case-insensitive. Only one of body and headers may consume stdin.

| Delivery | Signature headers                                                        |
| -------- | ------------------------------------------------------------------------ |
| Clerk    | `svix-id`, `svix-timestamp`, and `svix-signature`                        |
| Stripe   | `stripe-signature` (`t=...,v1=...`, including any additional signatures) |
| MoonPay  | `moonpay-signature-v2` (`t=...,s=...`)                                   |

For example, a Stripe headers file contains `{"stripe-signature":"t=CAPTURED_TIMESTAMP,v1=CAPTURED_DIGEST"}` with the actual captured values. The API selects the verification secret for that endpoint and environment and checks the signed timestamp; the CLI neither generates signatures nor refreshes timestamps. Expired or mismatched signatures remain errors. Arbitrary headers, including `Authorization`, `Cookie`, tenant selectors, and idempotency keys, are refused. Provided signature values and digests are redacted from structured API errors.

Ramp providers are `moonpay` and `stripe`. Choose sandbox or production explicitly; project selection does not choose the ingress environment. The API enforces its ramp module and provider gates. A ramp 200 response contains `{received: true, provider, environment}` and acknowledges a verified event durably stored in the inbox. Application and settlement run in the background and may fail, be ignored, or remain unmatched; receipt does not prove a transfer completed. Clerk returns `{received: true}` after processing supported events or ignoring others. Every invocation makes one request, refuses redirects, and performs no automatic retry, polling, re-signing, or inbox replay. These endpoints accept no `--idempotency-key`.

## Compliance

`compliance screen-address` covers `POST /v1/compliance/address-screenings`, currently the entire compliance API. It requires `compliance.execute` and a project-scoped API key, or a member session with `--project` / `SDP_PROJECT_ID`. The API enforces the deployment's release channel, organization provider activation, project entitlements, credentials, and screening quotas.

```sh
pnpm cli compliance --help
pnpm cli compliance screen-address --address ADDRESS
pnpm cli compliance screen-address --address ADDRESS --network solana \
  --intent transfer_destination --idempotency-key screening-42
pnpm cli compliance screen-address --data @screening.json
```

`--address` is required. Optional `--network` is the provider network identifier; the API owns normalization and defaults to `solana`. Optional `--intent` accepts `transfer_destination`, `wallet_address_addition`, or `unknown`; the server defaults to `unknown`. Omitted values remain omitted on the wire. Solana address validation runs on the API. Use `--data JSON|@file.json|-` instead of individual body flags for a complete body.

A request screens through the organization's enabled providers; there is no per-request provider selector. The response preserves the complete `screening` and `meta` envelope, each provider's `ok`, `pending`, `unavailable`, or `error` status, nullable or zero `riskScore`, optional risk label and message, verbatim `providerStatus`, and evaluation timestamps. Provider scores and labels are not normalized by the CLI. HTTP success can include incomplete or failed provider checks; inspect the provider results before using them.

`--idempotency-key` is optional. Supply a caller-chosen key when a later retry should replay the same screening; no key is generated automatically. The API processes replay before metered provider work. Keep the same request and credential for that logical screening, and read the API's replay-key guidance in command help. The CLI makes one request, never retries a quota, timeout, provider failure, or key conflict automatically, and does not poll pending checks. Without a key, a separate invocation starts a separate screening request.

## Places and Address Lookup

`places` covers the existing internal autocomplete, place-details, and static-map routes. All three require `counterparties.manage`, accept a project-bound API key or a Clerk session for the active organization, and charge the API's Places quota. Session calls do not require a selected project and do not send a project header. Google provider configuration remains on the API. These commands do not publish the routes in the public OpenAPI document.

```sh
pnpm cli places --help
pnpm cli places autocomplete --input "1600 Amphitheatre Parkway" --session-token lookup-42
pnpm cli places details get PLACE_ID --session-token lookup-42
pnpm cli places static-map download --latitude 0 --longitude 0 --output ./map.png
```

`autocomplete` takes `--input` (3–256 characters) and a caller-supplied `--session-token` (1–128 characters). For a complete body use `--data JSON|@file.json|-` instead of body flags. Reuse that lookup token when selecting a suggestion with `get PLACE_ID --session-token TOKEN`. This token groups provider lookups; it differs from the SDP account credential in `--token` / `SDP_TOKEN`. The CLI never generates a lookup token or requests details automatically. Place IDs and tokens are encoded as separate URL components, and the literal `static-map` path is reserved.

Autocomplete returns the full JSON envelope with `suggestions`, including an empty list or suggestions without secondary text. Place details return `placeId`, `formattedAddress`, numeric coordinates, and `addressFields` (`line1`, `line2`, `city`, `postalCode`, `countryCode`, `subdivisionCode`). Empty strings, leading zeros in postal codes, and zero coordinates remain unchanged. Trimming and provider address resolution run on the API.

`static-map` requires `--latitude` (-90 to 90), `--longitude` (-180 to 180), and `--output FILE`. Zero, negative, and boundary coordinates are accepted, using either `--longitude -122.084` or `--longitude=-122.084`. The API chooses map dimensions, zoom, scale, and marker. No lookup token is needed. The CLI checks that the output is a new file in an existing writable directory before making the request. It downloads the complete body, checks the PNG content type and signature, and saves the exact bytes with exclusive file creation. Existing files, including a file created during the request, are never overwritten. `--output -` is not supported. JSON errors, failed downloads, invalid response headers, and timeouts do not create a map file.

Map stdout remains JSON, reporting the absolute `path`, `contentType: "image/png"`, and `bytesWritten`; it does not contain the image bytes. The timeout covers the response body. Other Places commands preserve the API's JSON envelopes. Each invocation makes one request, with no automatic retries, token generation, autocomplete loops, details follow-up, or map follow-up. No Places route supports idempotency keys.

## Dashboard custody setup

`custody` covers all 16 routes under `/internal/dashboard/custody` and the related dashboard wallet-faucet and Fireblocks-destination routes. They remain internal. Every command requires a Clerk member session (`SDP_TOKEN`) and selected project. Setup administration requires `wallets.configure`; API keys cannot call any of these dashboard routes. The faucet requires `wallets.execute`. Destination inspection requires both `wallets.read` and `counterparties.read`. The API enforces provider availability, entitlements, lifecycle constraints, and quotas.

| Command                                                      | Behavior                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `custody providers list`                                     | Read installed provider counts and actual signing target types                 |
| `custody connections list`                                   | Read one connection page with optional provider filter                         |
| `custody connections get CONNECTION_ID`                      | Read installation status and available next actions                            |
| `custody connections credential-lifecycle get CONNECTION_ID` | Read safe credential metadata, impact, candidate, and retained rollback target |
| `custody credentials submit`                                 | Store a project-scoped pending Privy or Fireblocks installation                |
| `custody connections replace-credentials CONNECTION_ID`      | Replace credentials on an eligible pending installation                        |
| `custody connections complete-installation CONNECTION_ID`    | Explicitly validate and finish installation                                    |
| `custody connections cancel-installation CONNECTION_ID`      | Cancel an eligible pending installation                                        |
| `custody connections deactivate CONNECTION_ID`               | Deactivate the named connection                                                |
| `custody credentials rotate CREDENTIAL_ID`                   | Create and validate a linked rotation candidate                                |
| `custody credentials complete-rotation CREDENTIAL_ID`        | Resume validation of the named candidate                                       |
| `custody credentials rollback-rotation CREDENTIAL_ID`        | Restore an eligible retained predecessor of the current credential             |
| `custody credentials deactivate CREDENTIAL_ID`               | Deactivate an eligible unused credential                                       |
| `custody fireblocks csr get/create`                          | Read a pending public CSR or create registration material on the API           |
| `custody fireblocks vaults discover`                         | Discover one vault page using the server-held registration key                 |
| `custody fireblocks destination-eligibility get`             | Inspect the exact contact address's whitelist state                            |
| `custody wallets request-faucet WALLET_ID`                   | Request the server-selected devnet airdrop                                     |

Credential submission and replacement accept `--data JSON|@file.json|-`, or `--provider`, `--fields JSON`, optional `--request-delay-ms` (0–3000), `--wallet-label`, and `--fireblocks-vault-account-ids JSON_ARRAY`. Prefer a file or stdin so provider credentials do not enter shell history. The body must name `provider: privy|fireblocks` and include `fields.credentialLabel` and `fields.scope: project`. Privy authentication supplies `appId` and `appSecret`. Fireblocks supplies its API user ID in `fields.apiKey`, `vaultAccountId` as a string, and `signingKeyId` from a server-generated CSR. Raw private keys are not accepted. Selected Fireblocks vault IDs remain strings, must be distinct, and must include the signing vault. Zero request delay remains explicit; omitted defaults stay on the API.

Submission, replacement, rotation, and CSR creation require a caller-chosen `--idempotency-key`; no key is generated. These are the only dashboard custody commands exposing that flag. Rotation takes `--provider` and `--fields` (or a complete body) with registration authentication only, without installation labels or scope. The API fingerprints the intent and applies its own replay rules. Every command makes one request with no automatic completion, retry, rollback, deactivation, or polling.

Submission returns a pending credential and connection ID; it does not imply installation succeeded. `complete-installation` may return `success`, `failed`, or `retry_unknown`. Preserve those observations and the `canComplete`, `canReplaceCredentials`, and `canCancel` decisions rather than guessing the next action. Connection deactivation returns `custodyConnection`, whereas installation reads/cancellation return `connection`. Credential lifecycle reads include affected projects/connections, a nullable candidate, and a nullable rollback target with expiry. Rotation can fail or remain uncertain without triggering a rollback. The server enforces provider-account identity and reference checks before changing active credentials.

Connection lists accept `--provider`, `--limit`, and `--offset`, applied by the API before counting and slicing. The server defaults to 20 rows, truncates/clamps the limit to 1–50, and clamps offsets to safe integers. The CLI forwards finite numeric values and reads one page. Setup status reports existing records; environment credentials alone are not an installed configuration. An active connection and `isRuntimeExecutionAllowed` are distinct observations.

`fireblocks csr create` sends an explicit empty JSON object with a key; only the public CSR, ID, and expiry are returned. The private registration key stays on the API. Workspace registration and approval are separate operator steps. Vault discovery takes `--api-user-id`, `--signing-key-id`, optional `--after` cursor, and `--name-prefix`, or a complete JSON body. Its API user ID is separate from the SDP account `--api-key` flag. Discovery uses POST, preserves leading zeros in vault IDs, and returns `nextCursor` without automatically fetching another page.

Destination inspection takes `--custody-wallet-id`, `--counterparty-id`, `--counterparty-account-id`, `--address`, and `--asset` (a supported token symbol or mint). The API verifies those exact resources and returns `approved`, `pending`, or `not_whitelisted`; it does not send a payment. The faucet sends `{}` and accepts no caller amount. Its `lamports` remains a string and `confirmed`, `failed`, or `timeout` is printed as observed.

Responses contain safe metadata and public CSR material. Unexpected credential response fields are rejected before stdout, and submitted provider secrets are redacted from structured API errors, including encoded and JSON-escaped forms. Credentials are never stored by the CLI.

```sh
pnpm cli custody --help
pnpm cli custody providers list
pnpm cli custody credentials submit --data @privy-setup.json --idempotency-key install-42
pnpm cli custody connections get CONNECTION_ID
pnpm cli custody connections complete-installation CONNECTION_ID
pnpm cli custody fireblocks csr create --idempotency-key csr-42
pnpm cli custody credentials rotate CREDENTIAL_ID --data @rotation.json --idempotency-key rotation-42
```

Run any command with `--help` for its options. `--grant`, `--wallet-id`, and `--allowed-ip` are repeatable for API-key commands; wallet commands accept a single `--wallet-id`. Use `--data` instead of individual body flags; JSON bodies accept empty arrays and explicit `null` values where the API permits them. Empty project, organization, wallet, counterparty, and account updates are rejected locally. Updates change attributes; the API has no project create, delete, or archive endpoint.

```sh
pnpm cli projects update prj_example --settings '{"metadata":{"region":"US"}}'
pnpm cli projects update prj_example --data @project-update.json
printf '%s' '{"description":null}' | pnpm cli projects update prj_example --data -
pnpm cli projects api-keys create prj_example --name "Automation" \
  --grant projects.read --grant wallets.read --wallet-scope selected
```

API-key creation and rotation print the full new key to stdout once. Save that response securely. The CLI makes one request without automatic retries, redirects, or credential persistence. The server is authoritative for authorization and constraints not expressible in OpenAPI. Project updates accept an explicit idempotency header; current server support determines its replay behavior. Key creation and rotation do not accept idempotency keys because their responses contain secrets.

Successful JSON output preserves the API response: the complete `data` / `meta` envelope for SDP endpoints, and bare objects for health checks, public token metadata, and Solana Pay link endpoints. Discovery HTML and text are JSON strings; conditional documents and root redirects report their HTTP metadata. PNG static-map responses are saved to an explicit new output file, with JSON file metadata on stdout. A successful response with no content produces no stdout. `--compact` removes indentation; `--json` explicitly selects the default format. Errors are JSON on stderr with `code`, `message`, HTTP `status`, `requestId` when available, and redacted `details` when supplied by the API. Exit codes are `0` for success/help, `1` for API/network/response failures, and `2` for invalid usage or configuration. Use the built binary when piping output into other programs, so package-manager status lines do not enter the JSON stream.

## Extend and verify

Command names and flags live in `src/commands.ts`, `src/earn-commands.ts`, `src/issuance-commands.ts`, `src/private-channels-commands.ts`, `src/helius-rings-commands.ts`, `src/places-commands.ts`, `src/custody-commands.ts`, `src/webhook-input.ts`, and `src/discovery-commands.ts`. Paths, methods, request schemas, and response schemas come from OpenAPI through `apps/sdp-api/scripts/generate-cli-contract.ts`. Required actions and session-only requirements also use the canonical action registry and generated route inventory. The generated contract uses public schemas for public operations, with the internal transaction-history contract retaining every runtime module variant, and includes project administration, organization, member, invitation, API-key, internal counterparty, payment-request, payment-link, ramp-estimate, off-ramp-start, ramp-cancellation, Earn, DvP, Private Channels, Helius Rings routes (including its administrator connection paths), Places routes, dashboard custody helpers, the dashboard network snapshot, and signed webhook ingress from the internal document. API-key-secret, payment-link-token, and ramp-checkout-credential responses are identified from their generated response schemas. Public and link-token authorization are distinct from account authorization and omit account headers. Project and idempotency headers, pagination parameters, repeated query values, and route collisions are derived from those contracts. Signup, self-service membership, and session-only network and onboarding reads are distinct from tenant actions, while signed webhook ingress uses generated signature-header requirements and bounded raw-byte transport. Empty, PNG, text, redirect, not-modified, and diagnostic responses are represented explicitly. Path parameters come from the generated contract rather than per-command project flags. Public OpenAPI publication and release-channel policies remain owned by the API. Zod parses untrusted JSON and configuration. Ajv with its draft-04 adapter and format validators checks the OpenAPI 3.0 schemas directly, including exclusive ownership, provider variants, numeric bounds, and string formats, without transforming wire values.

To add another API family, extend the generator's family selection and add commands that reference its operation IDs. The shared runner handles authentication, URL construction, input and response validation, timeouts, and output. Coverage tests pin the implemented operation IDs to the generated contract and compare all 291 method/path pairs with the registered runtime. `pnpm generate:cli` also regenerates `COMMANDS.md`; `pnpm check:cli` checks both artifacts for drift.

```sh
pnpm generate:cli
pnpm check:cli
pnpm --filter @sdp/cli typecheck
pnpm --filter @sdp/cli test
pnpm --filter @sdp/cli build
pnpm check:module-boundaries
```
