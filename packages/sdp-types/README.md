# ⚠️ @sdp/types

**Internal package** — Shared TypeScript types and constants for the SDP monorepo.

## What is this?

This package provides:

- **Type definitions** — Shared interfaces used across `sdp-api`, `sdp-web`, and `sdp-api-integration`
- **Enums and constants** — Role, status, custody provider types
- **Schemas** — Request/response validation schemas

## For External Users

This package is **internal only** and not published to npm. If you're building an SDP client library, use the **public REST API** instead:

- **API Endpoint**: `https://platform.solana.com/api` (or `http://localhost:8787` locally)
- **OpenAPI Spec**: Available at `/openapi.json`
- **Public Docs**: https://platform.solana.com/docs

## For SDP Team Members

### Usage

```typescript
import { CustodyProvider, Permission, OrganizationRole } from "@sdp/types";
```

### File Structure

```
packages/sdp-types/
├── src/
│   ├── api-keys.ts
│   ├── custody.ts
│   ├── organizations.ts
│   ├── payments.ts
│   ├── permissions.ts
│   ├── projects.ts
│   ├── provider-access.ts
│   ├── sessions.ts
│   ├── site.ts
│   ├── tokens.ts
│   └── index.ts       # Re-exports everything
├── package.json
└── tsconfig.json
```

### Adding New Types

1. Create a new file in `src/` (e.g. `src/my-domain.ts`)
2. Export from `src/index.ts`

### Validation

Types use plain TypeScript — no Zod schemas in this package. For validated input parsing, see the API route handlers in `apps/sdp-api`.

## Contributing

- Keep types focused and specific
- Add JSDoc comments for complex types
- Update this README if adding new modules
- Run `pnpm --filter @sdp/types typecheck` before committing

## Support

- Type issues: GitHub Issues (tag with `types`)
