# SDP Types

Shared TypeScript types for the Solana Developer Platform.

## Structure

```
src/
├── index.ts          # Re-exports all types
├── organizations.ts  # Org, User, Role types
├── api-keys.ts       # API key types
├── permissions.ts    # Permission system
└── transactions.ts   # Transaction types (prepare/execute modes)
```

## Usage

```typescript
import { Organization, ApiKey, Permission } from '@sdp/types';
```

## Key Types

### Organizations
```typescript
interface Organization {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'suspended' | 'pending';
}
```

### API Keys
```typescript
interface ApiKey {
  id: string;
  organizationId: string;
  name: string;
  permissions: Permission[];
  expiresAt?: string;
}
```

### Transactions
```typescript
// Prepare mode response
interface PrepareTransactionResponse {
  transaction: {
    serialized: string;  // Base64 encoded
    message: string;
    recentBlockhash: string;
  };
  simulation?: SimulationResult;
}

// Execute mode response
interface ExecuteTransactionResponse {
  signature: string;
  status: 'confirmed' | 'finalized' | 'failed';
}
```

## Adding New Types

1. Create or edit file in `src/`
2. Export from `src/index.ts`
3. Run `pnpm build` to compile
4. Import in consuming packages
