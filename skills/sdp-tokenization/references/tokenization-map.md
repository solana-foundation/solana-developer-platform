# SDP Tokenization Map

Use this file as the quick reference for answering tokenization questions on top of Solana Developer Platform.

## Public source of truth

- Product overview: `apps/sdp-docs/content/docs/what-is-solana-developer-platform.mdx`
- Getting started: `apps/sdp-docs/content/docs/getting-started.mdx`
- Organization setup: `apps/sdp-docs/content/docs/guides/setup-organization.mdx`
- Wallet setup: `apps/sdp-docs/content/docs/guides/setup-wallets.mdx`
- API keys: `apps/sdp-docs/content/docs/guides/manage-api-keys.mdx`
- Create token: `apps/sdp-docs/content/docs/guides/create-a-token.mdx`
- Deploy token: `apps/sdp-docs/content/docs/guides/deploy-a-token.mdx`
- Mint and burn: `apps/sdp-docs/content/docs/guides/mint-and-burn.mdx`
- Allowlists: `apps/sdp-docs/content/docs/guides/manage-allowlists.mdx`
- Freeze and compliance: `apps/sdp-docs/content/docs/guides/freeze-and-compliance.mdx`
- Transfers: `apps/sdp-docs/content/docs/guides/transfer-tokens.mdx`
- Prepare vs execute: `apps/sdp-docs/content/docs/guides/prepare-vs-execute.mdx`
- Issuance OpenAPI paths: `apps/sdp-api/src/openapi/paths/issuance.ts`
- Payments OpenAPI paths: `apps/sdp-api/src/openapi/paths/payments.ts`
- Wallets OpenAPI paths: `apps/sdp-api/src/openapi/paths/custody.ts`
- API keys OpenAPI paths: `apps/sdp-api/src/openapi/paths/api-keys.ts`

## Business case to SDP mapping

### Stablecoin

- Template: `stablecoin`
- Typical controls:
  - mint authority
  - freeze authority
  - pause support
  - permanent delegate for admin recovery or force actions
- Typical public flow:
  1. Set up organization and wallets
  2. Create an API key with issuance permissions
  3. Create token
  4. Deploy token
  5. Mint to treasury or customer token accounts
  6. Transfer through payments
  7. Use freeze, unfreeze, or pause only if needed

### Tokenized security or regulated asset

- Template: `tokenized-security`
- Typical controls:
  - allowlist required or strongly recommended
  - freeze authority
  - pause support
  - permanent delegate or admin control path
- Typical public flow:
  1. Set up organization, wallets, and API keys
  2. Create token with allowlist-oriented defaults
  3. Deploy token
  4. Add holders to allowlist before distribution
  5. Mint to allowlisted token accounts
  6. Use freeze, seize, or force-burn only when policy requires it

### Loyalty, rewards, or game currency

- Template: `arcade`
- Typical controls:
  - mintable supply
  - optional pause support
  - optional allowlist if distribution is gated
- Typical public flow:
  1. Create token
  2. Deploy token
  3. Mint to user token accounts
  4. Transfer or redeem based on the app flow

### Bespoke asset model

- Template: `custom`
- Use when:
  - template defaults conflict with the real authority or extension model
  - the asset needs non-default metadata or extension settings
- Keep the answer explicit about which controls must be set manually.

## Minimal implementation sequence

1. Organization: `apps/sdp-docs/content/docs/guides/setup-organization.mdx`
2. Wallets: `apps/sdp-docs/content/docs/guides/setup-wallets.mdx`
3. API keys: `apps/sdp-docs/content/docs/guides/manage-api-keys.mdx`
4. Token creation: `apps/sdp-docs/content/docs/guides/create-a-token.mdx`
5. Deployment: `apps/sdp-docs/content/docs/guides/deploy-a-token.mdx`
6. Supply operations: `apps/sdp-docs/content/docs/guides/mint-and-burn.mdx`
7. Distribution and movement: `apps/sdp-docs/content/docs/guides/transfer-tokens.mdx`
8. Compliance controls: `apps/sdp-docs/content/docs/guides/manage-allowlists.mdx` and `apps/sdp-docs/content/docs/guides/freeze-and-compliance.mdx`

## Endpoint families to cite

- Wallets and custody:
  - `GET /v1/wallets`
  - `POST /v1/wallets`
- API keys:
  - `GET /v1/api-keys`
  - `POST /v1/api-keys`
- Issuance:
  - `GET /v1/issuance/templates`
  - `POST /v1/issuance/tokens`
  - `POST /v1/issuance/tokens/{tokenId}/deploy`
  - `POST /v1/issuance/tokens/{tokenId}/mint`
  - `POST /v1/issuance/tokens/{tokenId}/burn`
  - `POST /v1/issuance/tokens/{tokenId}/authority`
  - `POST /v1/issuance/tokens/{tokenId}/freeze`
  - `POST /v1/issuance/tokens/{tokenId}/unfreeze`
  - `POST /v1/issuance/tokens/{tokenId}/pause`
  - `POST /v1/issuance/tokens/{tokenId}/unpause`
  - `POST /v1/issuance/tokens/{tokenId}/supply/refresh`
- Payments and movement:
  - `POST /v1/payments/transfers`
  - `GET /v1/payments/transfers`
  - `GET /v1/payments/wallets/{walletId}/balances`

## Common caveats

- Authorities should default to SDP-controlled wallets when execute flows are expected to work without external signing.
- Token operations that mention an account often need a token account address, not the owner wallet address.
- The token must be `active` after deploy before minting or operational movement makes sense.
- Burn, freeze, seize, and related actions depend on the relevant authority actually being controlled by the selected signer.
