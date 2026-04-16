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
import { 
  User, 
  Organization, 
  Wallet,
  CustodyProvider,
  Permission
} from "@sdp/types";

const user: User = {
  id: "user_123",
  email: "dev@example.com",
  name: "Developer",
  permissions: [Permission.READ_WALLETS]
};
```

### File Structure

```
packages/sdp-types/
├── src/
│   ├── api/           # API request/response types
│   ├── domain/        # Domain entity types
│   ├── enums/         # Enums (Role, Status, etc.)
│   ├── schemas/       # Zod schemas for validation
│   └── index.ts       # Main export
├── package.json
└── tsconfig.json
```

### Adding New Types

1. Create a file in `src/domain/` or `src/api/`
2. Export from `src/index.ts`
3. Update tests if type has validation rules

### Validation

Types with strict validation use Zod schemas:

```typescript
// src/schemas/user.ts
import { z } from "zod";

export const UserSchema = z.object({
  id: z.string().startsWith("user_"),
  email: z.string().email(),
  permissions: z.array(z.enum(["READ_WALLETS", "WRITE_WALLETS"]))
});

export type User = z.infer<typeof UserSchema>;
```

## Contributing

- Keep types focused and specific
- Add JSDoc comments for complex types
- Include Zod schemas for validated types
- Update this README if adding new modules
- Run `pnpm --filter @sdp/types test` before committing

## Support

- Internal questions: Slack (team channel)
- Type issues: GitHub Issues (tag with `types`)
