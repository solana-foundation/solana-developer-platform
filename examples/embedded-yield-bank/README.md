# Northstar Bank

Northstar is a self-contained Next.js App Router example of a bank that offers
**Checking** and **Savings**, where Savings is one SDP Embedded Yield strategy.
The React UI and its server routes deploy together, while SDP builds the
transactions and keeps the movement ledger.

This is a real sandbox integration, not a fixture UI. Checking is the managed
wallet's token balance read from Solana devnet. Savings is the customer's
position in the featured strategy, valued by SDP. Moving money between the two
builds, signs, and submits real devnet transactions.

Only **Overview** is implemented. The other sidebar items are static navigation
affordances for the example.

## Screenshots

| Overview | Move to savings | SDP project portfolio |
| --- | --- | --- |
| ![Northstar overview](./screenshots/northstar-dashboard.jpg) | ![Move to savings dialog](./screenshots/northstar-deposit.jpg) | ![SDP Embedded Yield dashboard](./screenshots/sdp-embedded-yield-dashboard.jpg) |

## How the bank maps to SDP

| Northstar | SDP |
| --- | --- |
| Checking balance | The demo wallet's balance of the strategy's deposit token, read over RPC |
| Savings account | One `/v1/earn/strategies` entry: `DEMO_STRATEGY_ID`, or the first devnet strategy that is both instant-liquidity and USDC (with none qualifying, every page load fails until fixed) |
| Savings balance and earnings | The wallet's open position in that strategy; earnings use SDP's formula (value + finalized payouts - finalized deposits) over that strategy's movements only |
| Move to savings | Deposit preview when the strategy requires a floor, then build, server-side sign, submit |
| Move to checking | Token amount converted to shares at the live share price, then withdrawal preview, build, sign, submit |
| Recent activity | External-wallet movements whose provider and vault match the strategy, shown in the deposit token, kept after the position closes |

The customer never sees shares, providers, or slippage. Northstar demonstrates
the authenticated tier because it submits signed transactions to SDP and reads
the resulting tenant movements and positions. A keyless integration can list
strategies and build unsigned transactions, but it must broadcast and track
them itself and will not appear in Northstar's or SDP's tenant ledger.

The SDP client lives in [`server/sdp-client.ts`](server/sdp-client.ts), the
bank rules (strategy choice, amount to shares) in
[`server/savings.ts`](server/savings.ts), the transaction orchestration in
[`server/embedded-yield.ts`](server/embedded-yield.ts), and the Next.js route
handlers in [`src/app/api`](src/app/api).

## Architecture and security

- Next.js serves both the dashboard and `/api` route handlers from one origin.
- `SDP_API_KEY`, wallet private keys, and fee-payer keys are read only by
  modules guarded with `server-only`.
- The deployment, including signing routes, fails closed behind HTTP Basic
  auth using `DEMO_ACCESS_USERNAME` and `DEMO_ACCESS_PASSWORD`.
- Known link unfurlers (Slack, iMessage, X, Discord) may read the page shell
  at `/` without credentials so shared links render a card. The shell holds
  branding and metadata only; every API route still requires Basic auth. See
  [`server/link-preview.ts`](server/link-preview.ts).
- The favicon, social card, and `robots.txt` are public. Robots are asked not
  to index the demo.
- Deposit and withdrawal routes accept same-origin JSON requests only, before
  any request body can reach the server-side signer.
- No secret uses a `NEXT_PUBLIC_` prefix and no secret is serialized into page
  props or API responses.
- Transfer routes submit promptly. The browser polls every second until
  Solana confirms the transfer, then returns to a 30-second background refresh.
  It gives up after two minutes and backs off for exactly the `Retry-After` SDP
  sends on a 429. This avoids holding a serverless function open.
- Active refreshes are single-flight and silent. A slow RPC read cannot fan out
  overlapping requests, flash a loading skeleton, or animate the manual refresh
  control. The transfer dialog closes as soon as SDP accepts the movement while
  balances and activity update in place.
- A normal refresh costs two SDP calls (positions, movements) and one RPC read.
  While a transfer submitted from this browser tab awaits confirmation, one
  chain-aware detail read makes the UI reflect Solana confirmation immediately.
  Historical unresolved movements do not restart fast polling. The strategy
  catalogue is cached server-side for five minutes.
- While a transfer this browser submitted is pending, the page shows the
  balances it will produce and keeps the total fixed. At `confirmed`, the UI
  shows `Settled` and keeps that projection until both live account balances
  fully reflect the transfer. Each transfer has its own two-minute deadline, so
  one slow movement cannot clear or pause a newer projection. Overlapping
  deposits and withdrawals reconcile against their combined net effect. SDP
  continues tracking protocol finalization in the background without holding
  the customer in a loading state.
- API responses and outbound SDP reads use `no-store` caching.
- Submit retries reuse one `Idempotency-Key`.
- Quote-derived slippage floors and the amount-to-shares conversion use exact
  `BigInt` arithmetic.

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

   Also enable the comparison dashboard in `apps/sdp-web/.env.local`:

   ```dotenv
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
   [Circle faucet](https://faucet.circle.com/). The USDC balance is the
   customer's checking account.

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
into client-side settings. Shared links unfurl with the production hostname
that Vercel exposes as `VERCEL_PROJECT_PRODUCTION_URL`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SDP_API_BASE_URL` | No | SDP API origin. Defaults to local port `8787`; Vercel needs a reachable origin. |
| `SDP_API_KEY` | Yes | Sandbox project key with Embedded Yield read and write permissions. |
| `DEMO_ACCESS_USERNAME` | No | HTTP Basic username. Defaults to `northstar`. |
| `DEMO_ACCESS_PASSWORD` | Yes | HTTP Basic password protecting the page and all API routes. |
| `DEMO_WALLET_PRIVATE_KEY` | Yes | Base58 or JSON-array Solana keypair used only by the server. Its token balance is checking. |
| `DEMO_FEE_PAYER_PRIVATE_KEY` | No | Different funded devnet keypair that co-signs and pays network fees and account rent. |
| `DEMO_STRATEGY_ID` | No | Catalogue id of the strategy behind savings. Otherwise the first devnet strategy that is both instant-liquidity and USDC; with none qualifying, every page load fails until fixed. |
| `SOLANA_RPC_URL` | No | Devnet RPC used for direct wallet balance reads. |

## Local end-to-end notes

- Run SDP through a root Doppler-wrapped command such as `pnpm dev`.
- Keep the SDP database and Redis overrides pointed at `127.0.0.1` for local
  development.
- Enable both `MARKETS_ENABLED` and `EARN_ENABLED`.
- Use an API key from the exact sandbox project selected in the SDP dashboard.
- Restart Northstar after changing `.env.local`.
- Positions in strategies other than the featured one are hidden. Set
  `DEMO_STRATEGY_ID` to the strategy you deposited into if a balance seems to
  be missing.
- Wait for a submitted transfer to show `Settled` before comparing balances.
  `Settled` begins at Solana confirmation; SDP records protocol finalization in
  the background. The dashboard refreshes automatically for up to two minutes,
  then pauses and prompts for a manual refresh if confirmation is unresolved.

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
