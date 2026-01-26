# OpenAPI Specification

The SDP API specification, deployed to Vercel with Swagger UI.

## Files

- `sdp-api.yaml` - OpenAPI 3.0.3 specification
- `index.html` - Swagger UI viewer
- `vercel.json` - Vercel deployment config

## Deployment

Deployed under **Solana Foundation** Vercel account:

```bash
# Link (already done)
vercel link --scope solana-foundation

# Deploy
vercel --prod
```

**Production URL**: https://openapi-solana-foundation.vercel.app

## Spec Structure

```yaml
openapi: 3.0.3
info:
  title: Solana Developer Platform (SDP) API

paths:
  /issuance/tokens:           # Token creation
  /issuance/tokens/{id}/mint: # Mint (custody)
  /issuance/tokens/{id}/mint/prepare: # Mint (unsigned)
  /payments/transfers:        # Transfer (custody)
  /payments/transfers/prepare: # Transfer (unsigned)
  /transactions/prepare:      # Low-level tx builder

components:
  schemas:     # Request/response types
  parameters:  # Shared params (tokenId, etc.)
  securitySchemes:
    apiKey:    # X-API-Key header
```

## Signing Modes Convention

Each mutation endpoint has two variants:

| Endpoint | Signing |
|----------|---------|
| `POST /payments/transfers` | Custody (SDP signs) |
| `POST /payments/transfers/prepare` | User-managed (returns unsigned tx) |

Documentation lives in each endpoint's description, not top-level.

## Editing the Spec

1. Edit `sdp-api.yaml`
2. Validate: `npx @redocly/cli lint sdp-api.yaml`
3. Deploy: `vercel --prod`
4. Commit changes

## Tags

- `Issuance` - Token creation and management
- `Compliance` - Allowlist, freeze, seize
- `Payments` - Wallets, transfers, Solana Pay
- `Transactions` - Low-level signing/sending
- `Admin` - Usage analytics, audit logs
- `Webhooks` - Event notifications
