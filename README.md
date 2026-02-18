# Solana Developer Platform

## Clerk URL Configuration

Configure Clerk URLs through environment variables so invite/login links never resolve to localhost in deployed environments.

- `apps/sdp-web` (`.env.local` or deployment environment):
  - `NEXT_PUBLIC_CLERK_SIGN_IN_URL`
  - `NEXT_PUBLIC_CLERK_SIGN_UP_URL`
  - `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`
  - `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`
  - Optional: `NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL`
- `apps/sdp-api` (Cloudflare Worker variables per environment):
  - `FRONTEND_URL` (example: `https://app.example.com`)
  - `CLERK_INVITATION_REDIRECT_URL` (recommended, example: `https://app.example.com/sign-in`)
  - Optional: `CLERK_INVITATION_REDIRECT_ALLOWED_HOST_SUFFIXES` (comma-separated suffixes for dynamic web-origin redirects, example: `-solana-foundation.vercel.app`)

For local Worker development, copy `apps/sdp-api/.dev.vars.example` to `apps/sdp-api/.dev.vars`.

## Integration Tests (Devnet)

The integration test suite runs against Solana **devnet** and signs real transactions using the **local custody** provider.

### Prereqs

- Node `>=20`
- `pnpm` (repo pins `pnpm@10.15.1`)
- Solana CLI (for generating a devnet keypair): `solana-keygen`

### Required Environment Variables

Integration tests require:

- `SOLANA_RPC_URL`
  - Example: `https://api.devnet.solana.com`
- `CUSTODY_PRIVATE_KEY`
  - Base58-encoded **64-byte** Solana keypair (same format as `solana-keygen` keypair JSON, but base58-encoded).
- `KORA_RPC_URL`
  - Example: `https://kora-devnet-315956366746.us-central1.run.app`

Optional (recommended):

- `KORA_API_KEY`
  - Only required if your Kora endpoint needs it.
- `KORA_MIN_BALANCE_LAMPORTS`
  - Optional preflight threshold for the Kora fee payer balance.

### Generate a Local Custody Key

1. Create a new Solana keypair JSON:

```bash
solana-keygen new --no-bip39-passphrase --force -o /tmp/sdp-devnet-custody.json
```

2. Convert it to `CUSTODY_PRIVATE_KEY` base58 (64 bytes):

```bash
pnpm -C apps/sdp-api exec node --input-type=module - <<'NODE'
import fs from "node:fs";
import { getBase58Codec } from "@solana/codecs";

const base58 = getBase58Codec();
const bytes = Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/sdp-devnet-custody.json", "utf8")));
const privateKeyBase58 = base58.decode(bytes);

console.log("CUSTODY_PRIVATE_KEY=" + privateKeyBase58);
NODE
```

3. Fund the key (only needed if you do not use Kora fee sponsorship):

```bash
PUBLIC_KEY="$(solana-keygen pubkey /tmp/sdp-devnet-custody.json)"
solana config set --url devnet
solana airdrop 2 "$PUBLIC_KEY"
```

### Run Integration Tests

From the repo root:

```bash
export SOLANA_RPC_URL="https://api.devnet.solana.com"
export CUSTODY_PRIVATE_KEY="..."

export KORA_RPC_URL="https://kora-devnet-315956366746.us-central1.run.app"
# export KORA_API_KEY="..."

pnpm test:integration
```

Notes:

- The suite includes Kora tests. Kora connectivity/funding is validated up-front (fail-fast).
- Even with Kora fee sponsorship, the custody authority account must exist on-chain (some downstream SDKs require this).
  - The test preflight will attempt a small `requestAirdrop` on devnet if the custody account does not exist.
  - If your `SOLANA_RPC_URL` provider disables airdrops, you must fund the custody public key once (any amount) and rerun.
- If you want to run only the Kora smoke test: `pnpm kora:devnet:test`.
