# Northstar Bank

Northstar is a self-contained Next.js App Router example that shows how a
partner can put Embedded Yield inside its own customer dashboard. The React UI
and server API deploy together, while SDP remains the transaction builder and
movement ledger.

This is a real sandbox integration, not a fixture UI. The managed wallet's
balances come from Solana devnet. Strategies, positions, earnings, and activity
come from SDP. Deposits and withdrawals build, sign, and submit real devnet
transactions.

Northstar intentionally demonstrates the authenticated tier because it submits
signed transactions to SDP and reads the resulting tenant movements and
positions. A keyless integration can list strategies and build unsigned
transactions, but it must broadcast and track them itself and will not appear
in Northstar's or SDP's tenant ledger.

## Screenshots

| Partner overview | Fee-payer flow | SDP project portfolio |
| --- | --- | --- |
| ![Northstar customer dashboard](./screenshots/northstar-dashboard.jpg) | ![Northstar deposit dialog](./screenshots/northstar-deposit.jpg) | ![SDP Embedded Yield dashboard](./screenshots/sdp-embedded-yield-dashboard.jpg) |

Only **Overview** is implemented. The other sidebar items are static navigation
affordances for the example.

## Architecture and security

- Next.js serves both the dashboard and `/api` route handlers from one origin.
- `SDP_API_KEY`, wallet private keys, and fee-payer keys are read only by
  modules guarded with `server-only`.
- The whole deployment, including signing routes, fails closed behind HTTP
  Basic auth using `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD`.
- No secret uses a `NEXT_PUBLIC_` prefix and no secret is serialized into page
  props or API responses.
- Movement routes submit promptly. The browser polls the dashboard route for
  finality, which avoids holding a serverless function open while Solana
  settles.
- API responses and outbound SDP reads use `no-store` caching.
- Submit retries reuse one `Idempotency-Key`.
- Quote-derived slippage floors use exact `BigInt` arithmetic.

The SDP client lives in [`server/sdp-client.ts`](server/sdp-client.ts), the
transaction orchestration in
[`server/embedded-yield.ts`](server/embedded-yield.ts), and the Next.js route
handlers in [`src/app/api`](src/app/api).

## Run locally

Prerequisites are Node.js 24+, pnpm 10.16+, Docker, and the team Doppler
development configuration described in
[`docs/ops/doppler-secrets.md`](../../docs/ops/doppler-secrets.md).

1. Install the repository and standalone example dependencies from the
   repository root:

   ```bash
   pnpm install --frozen-lockfile
   pnpm -C examples/embedded-yield-bank install --frozen-lockfile
   ```

   The example has its own lockfile so it stays copyable and does not add
   demo-only packages to the production workspace.

2. Add these local-only overrides to `apps/sdp-api/.env.local`:

   ```dotenv
   DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5432/sdp
   REDIS_URL=redis://127.0.0.1:6379
   MARKETS_ENABLED=true
   EARN_ENABLED=true
   ```

3. Start the local SDP stack:

   ```bash
   pnpm dev
   ```

   This starts local Postgres and Redis, applies migrations, and serves the SDP
   API at `http://127.0.0.1:8787` and dashboard at `http://localhost:3000`. The
   API syncs the Earn strategy catalogue at startup and hourly afterward, so a
   fresh database lists strategies within a few seconds.

4. In the local SDP dashboard, select a sandbox project and create a Developer
   API key from **API keys** in the sidebar. The Developer role includes
   `earn:read` and `earn:write`. Copy the full key when it is shown.

5. Generate the demo customer's managed wallet:

   ```bash
   pnpm --filter @sdp/api keygen:local
   ```

   Save `PUBLIC_KEY` for funding and `CUSTODY_PRIVATE_KEY` for the example.

6. Create the example environment file and fill in the values:

   ```bash
   cp examples/embedded-yield-bank/.env.example examples/embedded-yield-bank/.env.local
   ```

7. Fund `PUBLIC_KEY` with devnet SOL and official devnet USDC using the
   [Solana faucet](https://faucet.solana.com/) and
   [Circle faucet](https://faucet.circle.com/).

8. Start Northstar from the repository root:

   ```bash
   pnpm dev:example:embedded-yield
   ```

Open `http://127.0.0.1:4173` and enter the configured Basic auth credentials.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Set the project root directory to `examples/embedded-yield-bank`. Vercel
   detects Next.js automatically.
3. Add every variable from `.env.example` to the intended Vercel environment.
   Use a long random `DEMO_ACCESS_PASSWORD`.
4. Set `SDP_API_BASE_URL` to an SDP endpoint reachable from Vercel. A loopback
   URL such as `127.0.0.1` only works locally.
5. Deploy and authenticate with the configured Basic auth credentials.

Keep the API key, wallet key, and optional fee-payer key limited to the Vercel
server environment. Do not expose them as `NEXT_PUBLIC_*` values or paste them
into client-side settings.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SDP_API_BASE_URL` | No | SDP API origin. Defaults to local port `8787`; Vercel needs a reachable origin. |
| `SDP_API_KEY` | Yes | Sandbox project key with Embedded Yield read and write permissions. |
| `DEMO_ACCESS_USERNAME` | No | HTTP Basic username. Defaults to `northstar`. |
| `DEMO_ACCESS_PASSWORD` | Yes | HTTP Basic password protecting the page and all API routes. |
| `DEMO_WALLET_PRIVATE_KEY` | Yes | Base58 or JSON-array Solana keypair used only by the server. |
| `DEMO_FEE_PAYER_PRIVATE_KEY` | No | Different funded devnet keypair that co-signs and pays network fees and account rent. |
| `SOLANA_RPC_URL` | No | Devnet RPC used for direct wallet balance reads. |

## Local end-to-end notes

- Run SDP through a root Doppler-wrapped command such as `pnpm dev`.
- Keep the SDP database and Redis overrides pointed at `127.0.0.1` for local
  development.
- Enable both `MARKETS_ENABLED` and `EARN_ENABLED`.
- Use an API key from the exact sandbox project selected in the SDP dashboard.
- Restart Northstar after changing `.env.local`.
- Wait for a submitted movement to finalize before comparing balances. The
  dashboard refreshes automatically while a movement is pending.

## Validation

From the repository root:

```bash
pnpm -C examples/embedded-yield-bank test
pnpm -C examples/embedded-yield-bank typecheck
pnpm -C examples/embedded-yield-bank lint
pnpm -C examples/embedded-yield-bank build
```

This example is for devnet evaluation only. Basic auth protects the demo from
casual public access, but the in-process private-key signer is not production
custody infrastructure.
