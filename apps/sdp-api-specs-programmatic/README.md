# Programmatic OpenAPI (Generated)

This folder hosts the programmatic OpenAPI spec generated from the SDP API Zod schemas.
It is intended for an automated Vercel deployment that updates when the schema changes.

## Files

- `generated/openapi.json` - Generated OpenAPI 3.0.3 specification
- `index.html` - Swagger UI viewer
- `vercel.json` - Vercel deployment config (static)

## Generate the spec

From the repo root:

```bash
pnpm --filter @sdp/api openapi:generate
```

This writes `apps/sdp-api-specs-programmatic/generated/openapi.json`.

## Vercel project setup

Create a new Vercel project under the `solana-foundation` org and set:

- **Root Directory**: `apps/sdp-api-specs-programmatic`
- **Framework**: Other / Static
- **Build Command**: none (static)
- **Output Directory**: `.`

Every push to the tracked branch will deploy the generated spec.

## URL

Fill in once the new Vercel project is created.
