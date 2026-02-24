# Anchorage API Research for SDP Custody Integration

Date: February 24, 2026
Owner: SDP API team
Status: Draft, validated against current public developer docs

## Goal

Determine whether Anchorage can be integrated as an SDP custody provider and confirm whether a transaction/message signing endpoint exists.

## Sources

- [Anchorage Developer Portal](https://developers.anchorage.com) (authenticated)
- [Generate ed25519 Keys](https://developers.anchorage.com/reference/generate-ed25519-keys)
- [Transfers vs Withdrawal API](https://developers.anchorage.com/docs/transfers-v-withdrawal-api)
- [Configure webhook notifications](https://developers.anchorage.com/docs/configure-webhook-notifications)

## Confirmed Findings

### API auth and request signing

- API base URLs are documented as:
  - `https://api.anchorage.com/v2` (prod)
  - `https://api.anchorage-staging.com/v2` (staging)
- Requests use `Api-Access-Key`.
- Some endpoints require `Api-Signature` + `Api-Timestamp`.
- Signature is an Ed25519 signature over:
  - `timestamp + HTTP_METHOD + path_with_query + request_body`
- Timestamp must be close to server time (about 1 minute window).

### Operational endpoint surface (custody APIs)

The authenticated API reference navigation enumerates these operational endpoint groups:

- API key: inspect key and permissions
- Vaults and wallets: list/get vaults, list/get/create wallets
- Addresses: list/provision deposit addresses
- Transfers: create/list/get/cancel
- Transactions: list/get plus create withdrawal/stake/unstake/collect
- Trusted destinations: create/list/status/cancel/delete
- Webhooks: endpoint/subscription management, event types, validation key

### Platform behaviors

- Idempotency is supported for selected write endpoints (for example transfer creation).
- Rate limiting is documented at org level.
- Pagination is cursor style (`afterId` / `page.next`).
- Error model includes `errorType` and message.

## Signing Endpoint Investigation

## Question

Does Anchorage expose an API endpoint to sign arbitrary Solana transaction bytes/messages (the SDP `SigningPort` contract)?

## What was checked

- Full authenticated API reference endpoint list from the developer portal.
- Docs search for `sign`, `sign transaction`, `message signing`, and `raw signing`.
- Security docs around signatures.

## Evidence

- [Generate ed25519 Keys](https://developers.anchorage.com/reference/generate-ed25519-keys) describes request authentication signatures (`Api-Signature`), not custody signing of blockchain transaction payloads.
- The reference endpoint list includes transfer/withdrawal/staking style operations, but no endpoint named or described as:
  - sign transaction
  - sign message
  - create signature for transaction payload

## Conclusion

As of February 24, 2026, no public Anchorage API endpoint is documented for arbitrary Solana transaction/message signing.

## Confidence and caveat

- Confidence: High for currently documented public endpoints.
- Caveat: Anchorage may have private or tenant-gated capabilities not visible in public docs. This requires direct confirmation from Anchorage solutions/support.

## Impact on SDP Architecture

Current SDP custody integration is signer-first and expects raw transaction signing via [`SigningPort`](../../apps/sdp-api/src/services/ports/signing.port.ts). Without a raw signing endpoint, Anchorage cannot be treated as a drop-in signing adapter.

Practical integration path:

- Integrate Anchorage first as an operations custody backend (wallets/addresses/transfers/withdrawals/webhooks).
- Keep existing signer providers for issuance and signer-dependent transfer flows.
- Add a capability gate so Anchorage can become a signing provider later if Anchorage confirms a signing API.
