# SDP Web

Dashboard application for the Solana Developer Platform.

## Local Development

From the repo root, install dependencies and start the workspace:

```bash
pnpm install
pnpm dev
```

The dashboard runs at [http://localhost:3000](http://localhost:3000) by default. The
root scripts load local Doppler configuration before starting the app, so provider
keys must be configured for workflows that call external services.

## Checks

```bash
pnpm --filter sdp-web typecheck
pnpm --filter sdp-web build
```

The dashboard proxies public docs routes to `apps/sdp-docs`; set
`SDP_DOCS_PROXY_ORIGIN` to override the default local or production docs origin.
