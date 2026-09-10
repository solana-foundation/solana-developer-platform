# Northstar Bank

Northstar is a small full-stack bank demo built with Vite, React, Hono, and shadcn/ui. It shows how a partner can put Embedded Yield inside its own customer dashboard while SDP remains the transaction builder and movement ledger.

This is a real sandbox integration, not a fixture UI. The balances come from the managed wallet on Solana devnet. Strategies, positions, earnings, and activity come from the local SDP API. Deposits and withdrawals create and submit real devnet transactions, then appear in both Northstar and the SDP Embedded Yield dashboard.

## Screenshots

| Partner experience | SDP project portfolio |
| --- | --- |
| ![Northstar customer dashboard](./screenshots/northstar-dashboard.jpg) | ![SDP Embedded Yield dashboard](./screenshots/sdp-embedded-yield-dashboard.jpg) |

## What the example demonstrates

- Keep the SDP API key and wallet private key on the Hono server.
- Show the fundable devnet strategies the managed wallet can actually enter.
- Read the customer's token and SOL balances directly from devnet.
- Preview a deposit when the strategy requires a quote-derived floor.
- Derive slippage floors with exact `BigInt` arithmetic.
- Build, sign, and submit a caller-owned wallet transaction.
- Retry submits safely with an `Idempotency-Key`.
- Poll until `finalized` or `failed`, never stopping at `confirmed`.
- Page positions to completion and preserve unavailable live values.
- Quote a position-based withdrawal when required, then build and submit it.

The API-shaped code lives in [`server/sdp-client.ts`](server/sdp-client.ts). The orchestration that follows the documented flow lives in [`server/embedded-yield.ts`](server/embedded-yield.ts). The React application only talks to the example's `/api` routes.

## Run the full stack

Prerequisites are Node.js 24+, pnpm 10.16+, Docker, and the team Doppler development configuration described in [`docs/ops/doppler-secrets.md`](../../docs/ops/doppler-secrets.md).

1. Install the repository and standalone example dependencies from the repository root:

   ```bash
   pnpm install --frozen-lockfile
   pnpm -C examples/embedded-yield-bank install --frozen-lockfile
   ```

   The example has its own lockfile so it stays copyable and does not add demo-only UI packages to the production workspace.

2. Add these local-only overrides to `apps/sdp-api/.env.local`:

   ```dotenv
   DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5432/sdp
   REDIS_URL=redis://127.0.0.1:6379
   MARKETS_ENABLED=true
   EARN_ENABLED=true
   ```

   The repository's Doppler wrapper applies `.env.local` after the selected development config. This keeps SDP data in the local Docker services and enables Embedded Yield in both the API and dashboard.

3. Start the local SDP stack in the first terminal:

   ```bash
   pnpm dev
   ```

   This starts local Postgres and Redis, applies migrations, and serves the SDP API at `http://127.0.0.1:8787` and dashboard at `http://localhost:3000`.

4. In the local SDP dashboard, select a sandbox project and create a Developer API key. The Developer role includes `earn:read` and `earn:write`. Copy the full key when it is shown.

5. Generate the demo customer's managed wallet:

   ```bash
   pnpm --filter @sdp/api keygen:local
   ```

   Save `PUBLIC_KEY` for funding and `CUSTODY_PRIVATE_KEY` for the example environment. These are demo-only devnet credentials.

6. Create the example environment file:

   ```bash
   cp examples/embedded-yield-bank/.env.example examples/embedded-yield-bank/.env
   ```

   Set `SDP_API_KEY` and set `DEMO_WALLET_PRIVATE_KEY` to the generated `CUSTODY_PRIVATE_KEY`. Keep `SDP_API_BASE_URL=http://127.0.0.1:8787` for the local stack.

7. Fund `PUBLIC_KEY` before the demo:

   - Add devnet SOL for transaction fees with the [Solana faucet](https://faucet.solana.com/).
   - Add official devnet USDC with the [Circle faucet](https://faucet.circle.com/). Choose USDC and Solana Devnet.

8. Start Northstar in a second terminal from the repository root:

   ```bash
   pnpm dev:example:embedded-yield
   ```

Open `http://127.0.0.1:4173`. Deposit into a listed strategy, wait for the success toast, then open `http://localhost:3000/dashboard/markets/embedded-yield`. The new external-wallet position and movement should be visible in the same sandbox project. A withdrawal from Northstar should update both views again.

## Local end-to-end gotchas

- Run the API through a root Doppler-wrapped command such as `pnpm dev`. Starting `pnpm -C apps/sdp-api dev:local` directly omits the Clerk development configuration, so the signed-in dashboard cannot authenticate to the API.
- Keep `DATABASE_URL` and `REDIS_URL` pointed at `127.0.0.1` in `apps/sdp-api/.env.local`. A Doppler config may contain shared development store URLs, and plain shell exports do not override Doppler unless `DOPPLER_PRESERVE_ENV` is set.
- Enable both `MARKETS_ENABLED` and `EARN_ENABLED` for the API and web processes. Enabling only the web app renders the route, but the API correctly answers Embedded Yield requests with `403`.
- Use an API key created in the exact project selected in the dashboard's top-left project switcher. API keys and Embedded Yield movements are project-scoped. A valid key from another project will make Northstar work while the open dashboard shows different aggregate data.
- Restart Northstar after changing `examples/embedded-yield-bank/.env`; the server reads secrets at startup.
- Wait for Northstar's finalized success toast before comparing balances. In local development, the open and visible Embedded Yield dashboard polls live position totals every three seconds, so the matching strategy total should change within one or two refresh cycles without a page reload.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SDP_API_BASE_URL` | No | SDP API origin. Defaults to local port `8787`. |
| `SDP_API_KEY` | Yes | Sandbox project key with Embedded Yield read and write permissions. |
| `DEMO_WALLET_PRIVATE_KEY` | Yes | Base58 or JSON-array Solana keypair used by the example server. |
| `SOLANA_RPC_URL` | No | Devnet RPC used for direct wallet balance reads. |
| `DEMO_API_PORT` | No | Hono server port. Defaults to `4174`. |

Never prefix secrets with `VITE_`. Vite exposes those values to browser code.

## Validation

From the repository root:

```bash
pnpm -C examples/embedded-yield-bank test
pnpm -C examples/embedded-yield-bank typecheck
pnpm -C examples/embedded-yield-bank lint
pnpm -C examples/embedded-yield-bank build
```

This example is for devnet evaluation only. Do not use its in-process private-key signer for production custody.
