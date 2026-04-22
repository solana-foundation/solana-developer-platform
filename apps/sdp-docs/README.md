# SDP Docs

Public documentation site for the Solana Developer Platform, generated with Fumadocs and Next.js.

## What is SDP Docs?

SDP Docs is the comprehensive external-facing documentation for the SDP platform, covering:

- **Getting Started** — Quickstart guides for developers
- **API Reference** — Detailed documentation for all public REST endpoints
- **Guides & Tutorials** — Step-by-step walkthroughs for common tasks
- **Wallets & Custody** — Managing blockchain accounts with custodial providers
- **Token Issuance** — Creating and managing SPL tokens
- **Payments** — Sending funds with compliance screening
- **Compliance** — Using AML/KYC integrations
- **On/Off Ramps** — Fiat integration guides
- **API Keys & Auth** — Authentication and authorization
- **Projects & Organizations** — Multi-tenant management

## Local Development

### Prerequisites

- **Node.js 20+**
- **pnpm 10.15.1+**

### Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Start the dev server:**
   ```bash
   # From repo root
   pnpm dev

   # Or from apps/sdp-docs directory
   pnpm dev:docs
   ```

   The documentation site will be available at `http://localhost:3001` (or the next available port)

## Documentation Structure

```
apps/sdp-docs/
├── src/
│   ├── app/              # Next.js App Router
│   │   └── docs/         # Fumadocs documentation root
│   └── lib/              # Fumadocs source config
├── content/
│   └── docs/             # Markdown documentation files
│       ├── guides/       # How-to guides
│       ├── reference/    # API and concept reference
│       └── tutorials/    # Step-by-step tutorials
├── scripts/              # Doc generation scripts
└── public/               # Static assets (logos, images)
```

## Writing Documentation

### Adding a New Page

1. Create a markdown file in `content/section-name/your-page.md`:

```markdown
---
title: Your Page Title
description: Brief description for search results
---

# Your Page Title

Your content here...
```

2. The page will automatically be included in the navigation based on directory structure.

### Markdown Format

Use standard Markdown with these extensions:

**Code blocks with language highlighting:**
```typescript
const greeting = "Hello, SDP!";
```

**Info boxes:**
```markdown
:::info
This is important information.
:::

:::warning
This is a warning.
:::

:::success
This is a success message.
:::
```

**API reference (if applicable):**
```markdown
## POST /v1/wallets

Creates a new blockchain wallet.

### Parameters

- `organization_id` (required) — Organization UUID
- `custody_provider` (required) — Custody backend (privy, coinbase_cdp, etc.)

### Response

```json
{
  "id": "wal_...",
  "organization_id": "org_...",
  "address": "..."
}
```
```

### Content Guidelines

- **Write for external developers** — assume no knowledge of internal infrastructure
- **Be clear and concise** — use short sentences and bulleted lists
- **Provide examples** — show working code samples
- **Link related docs** — help readers navigate
- **Avoid internal jargon** — explain SDP-specific terms on first use
- **Mark beta/experimental features** — use callout boxes

## Building the Docs

### Development Build

Already served by `pnpm dev:docs`

### Production Build

```bash
pnpm --filter sdp-docs build
```

Output goes to `apps/sdp-docs/.next/`

### Publishing

Docs are deployed via:
- **Staging**: Automatically on commits to `main`
- **Production**: Automatically on release tags (`v*.*.*` or `solana-developer-platform-v*.*.*`)

See [`docs/ops/release-operations.md`](../../docs/ops/release-operations.md) for details.

## Updating the Public API Reference

The API reference is auto-generated from the SDP API's OpenAPI spec.

### To update:

1. Ensure the SDP API is running:
   ```bash
   pnpm dev
   ```

2. The OpenAPI spec is available at:
   ```
   GET http://localhost:8787/openapi.json
   ```

3. To regenerate docs from the spec:
   ```bash
   pnpm -C apps/sdp-docs generate:api
   ```

## Testing

### Link validation

```bash
pnpm --filter sdp-docs check:links
```

Ensures all internal and external links are valid.

### Build validation

```bash
pnpm --filter sdp-docs build
```

Verifies the documentation builds without errors.

## Troubleshooting

### Port 3001 already in use
```bash
# Use a different port
PORT=3002 pnpm dev:docs
```

### Changes not showing up
- Clear `.next/` cache: `rm -rf apps/sdp-docs/.next`
- Restart dev server: `Ctrl+C` and `pnpm dev:docs` again

### Markdown not rendering correctly
- Check file is in `content/` directory
- Verify frontmatter is valid YAML
- Ensure markdown syntax is correct (code blocks closed, etc.)

## Contributing

- Follow markdown conventions (see above)
- Request review from product team before merging
- Test links locally: `pnpm --filter sdp-docs check:links`

For full contribution guidelines, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Tech Stack

- **Next.js** — React framework
- **Fumadocs** — Documentation framework
- **Markdown** — Content format
- **TypeScript** — Type safety
- **Tailwind CSS** — Styling

## Publishing

The docs are published to https://platform.solana.com/docs

- **Staging**: Automatically deployed on commits to `main`
- **Production**: Automatically deployed on release tags

## Support

- **Report issues**: GitHub Issues (tag with `docs`)
