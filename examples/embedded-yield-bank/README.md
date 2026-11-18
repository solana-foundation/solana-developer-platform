# Northstar Bank

Northstar is a self-contained Next.js App Router example of a bank that offers
**Checking** and **Savings**, where Savings is one SDP Earn strategy.
The React UI and its server routes deploy together, while SDP builds the
transactions and tracks each operation through signing, approval and settlement.

This is a real integration, not a fixture UI. It defaults to a sandbox project
on devnet and can run a controlled production-project canary on mainnet.
Checking is the managed wallet's token balance read from the configured Solana
cluster. Savings is the customer's position in the featured strategy, valued
by SDP. Moving money between the two builds, signs, and submits real
transactions on that cluster.

Only **Overview** is implemented. The other sidebar items are static navigation
affordances for the example.

## Screenshots

| Overview                                                     | Move to savings                                                | SDP project portfolio                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![Northstar overview](./screenshots/northstar-dashboard.jpg) | ![Move to savings dialog](./screenshots/northstar-deposit.jpg) | ![SDP Embedded Yield dashboard](./screenshots/sdp-embedded-yield-dashboard.jpg) |

## How the bank maps to SDP

| Northstar             | SDP                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Savings strategy      | `/v1/earn/discovery`, selected by `DEMO_STRATEGY_ID` or the first fundable DeFi USDC strategy on the configured cluster                   |
| Savings holding       | `/v1/earn/positions?sourceType=address&ownerAddress=...&discover=true`, including verified pre-existing holdings in integrated strategies |
| Move to savings       | `/v1/earn/deposit` prepares an operation for review                                                                                       |
| Move to checking      | `/v1/earn/withdraw` prepares an operation using the position ID and token amount                                                          |
| Approval and progress | `/v1/operations/{id}/execute`, then operation reads until verified completion                                                             |
| Cancellation          | `/v1/operations/{id}/cancel`, followed by any returned signature action and continued polling                                             |
| Updated terms         | `/v1/operations/{id}/refresh`, when the operation offers a refresh action                                                                 |

Preparing shows current estimates, minimum proceeds, fees and withdrawal options.
It does not sign or broadcast. **Approve execution** signs the exact transaction
returned by SDP and submits the reviewed action ID and version. Execute returns
`202` when work is durably accepted. SDP's worker handles submission, custody
approval and settlement asynchronously. A queue request escrows shares; completion
requires a verified payout or return of shares.

Checking is the wallet's observed token balance. Savings uses SDP's observed
position value, with unavailable values left unknown. Discovery cannot establish
an acquisition date or cost basis for pre-existing holdings, so their earnings
remain unknown. APY is a decimal fraction with provider provenance and an
observation timestamp, which can also be unknown.

The four Earn endpoints serve this bank and the Treasury dashboard. The demo
uses owner addresses, without registering custody wallets. All activity and
pending withdrawals use the same shared operation lifecycle.

The HTTP client is in [`server/sdp-client.ts`](server/sdp-client.ts), server-side
signing in [`server/embedded-yield.ts`](server/embedded-yield.ts), and operation
recovery in [`src/lib/core-api.ts`](src/lib/core-api.ts).

## Architecture and security

- The API key and wallet keys stay in `server-only` modules. The page and API
  routes require the configured HTTP Basic credentials. Known link unfurlers
  can read the public page shell, which contains no account data.
- Mutations accept same-origin JSON. Before signing, the server checks the
  operation's wallet owner, the configured cluster and the expected fee payer.
  It signs SDP's exact stored message, including the optional partner fee payer.
- Preparation keys are saved before sending. The browser saves the reviewed
  operation action and idempotency key before asking the server to sign. Web
  Locks serialize execution across tabs. Storage refusal blocks a new action.
- Uncertain submissions retain the same action ID, version and idempotency key.
  Immediate retries send identical signed bytes; reload reads the same stored
  operation before signing. An advanced action returns its current state.
  A validated acknowledgement for that operation releases the local journal.
- Browser storage is only the example's recovery journal. A production app
  needs authenticated durable recovery across devices.
- Active dashboard reads are single-flight and poll every two seconds. Idle reads
  run every 30 seconds. HTTP 429 pauses polling for the server's retry interval.
  The server caches discovery for five minutes; live balances are never inferred
  from requested transfer amounts.
- A normal refresh reads operations and positions, plus the checking token
  balance over RPC. Position discovery covers
  integrated strategies only; unavailable observations never count as empty.
- Pending withdrawal quotes never count as delivered assets. Earnings and
  portfolio totals remain unknown while escrow cannot be valued. Completed
  activity displays only verified settled amounts.
- API responses and SDP requests use `no-store`. No secret uses a
  `NEXT_PUBLIC_` variable or appears in browser props or API responses.

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
   ```

   The local `experimental` release channel runs Earn in both apps.

3. Start the local SDP stack:

   ```bash
   pnpm dev
   ```

   This starts local Postgres and Redis, applies migrations, and serves the SDP
   API at `http://127.0.0.1:8787` and dashboard at `http://localhost:3000`. The
   API syncs the Earn strategy catalogue at startup and hourly afterward, so a
   fresh database lists strategies within a few seconds.

4. In the local SDP dashboard, select a sandbox project and create an API key
   from **API keys** in the sidebar. Grant **Earn** Read, Execute and Manage
   (Manage builds the owner-signed recovery of an expired queued withdrawal).
   Northstar never signs with a custody wallet, so give it the narrowest wallet
   access the form allows. Copy the full key when it is shown.

5. Generate the demo customer's managed wallet:

   ```bash
   pnpm --filter @sdp/api keygen:local
   ```

   Save `PUBLIC_KEY` for funding and `CUSTODY_PRIVATE_KEY` for the example.

6. Create the example environment file and fill in the values:

   ```bash
   cp examples/embedded-yield-bank/.env.example examples/embedded-yield-bank/.env.local
   ```

7. Fund `PUBLIC_KEY` with SOL and official USDC on `SOLANA_CLUSTER`. For the
   default devnet configuration, use the [Solana faucet](https://faucet.solana.com/)
   and [Circle faucet](https://faucet.circle.com/). The USDC balance is the
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

### Updating the hosted demo

The team's hosted demo is the `earn-embedded-demo` project in the
`solana-foundation` Vercel team. **It is not on CI/CD.** Git is disconnected,
so pushes and merges never build or deploy it and post no PR check. Deploy
updates by hand with the Vercel CLI. You need access to that Vercel project;
its environment variables already live there.

From a clean checkout of the commit you want live, at the repository root (the
project's root directory setting already points at this example):

```bash
pnpm dlx vercel@60.1.3 login
pnpm dlx vercel@60.1.3 link --scope solana-foundation --project earn-embedded-demo --yes
pnpm dlx vercel@60.1.3 deploy
pnpm dlx vercel@60.1.3 deploy --prod
```

`link` runs once per checkout and writes the gitignored `.vercel/`. Plain
`deploy` gives a preview URL to check first. `deploy --prod` is a separate
production build from the same tree, not a promotion of that preview, and uses
the Production environment variables. The CLI uploads your working tree, so
uncommitted changes ship too. Run the [validation](#validation) commands before deploying.

## Configuration

| Variable                     | Required | Purpose                                                                                                                                                                    |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SDP_API_BASE_URL`           | No       | SDP API origin. Defaults to local port `8787`; Vercel needs a reachable origin.                                                                                            |
| `SDP_API_KEY`                | Yes      | Project key with Earn read and execute grants; manage is needed for cancellation. Use a sandbox key for devnet or production key for mainnet.                              |
| `DEMO_ACCESS_USERNAME`       | No       | HTTP Basic username. Defaults to `northstar`.                                                                                                                              |
| `DEMO_ACCESS_PASSWORD`       | Yes      | HTTP Basic password protecting the page and all API routes.                                                                                                                |
| `DEMO_WALLET_PRIVATE_KEY`    | Yes      | Base58 or JSON-array Solana keypair used only by the server. Its token balance is checking.                                                                                |
| `DEMO_FEE_PAYER_PRIVATE_KEY` | No       | Different funded keypair on `SOLANA_CLUSTER` that co-signs and pays network fees and account rent. This is the partner fee-payer path and does not use Kora.               |
| `DEMO_STRATEGY_ID`           | No       | Catalogue id of the strategy behind savings. Otherwise the first fundable DeFi USDC strategy on `SOLANA_CLUSTER`; with none qualifying, every page load fails until fixed. |
| `SOLANA_CLUSTER`             | No       | `devnet` by default, or `mainnet-beta` for a controlled production-project canary.                                                                                         |
| `SOLANA_RPC_URL`             | No       | RPC used for direct wallet balance reads and transaction submission. Its genesis hash must match `SOLANA_CLUSTER`.                                                         |

## Controlled mainnet canary

Mainnet mode uses real assets and broadcasts real transactions. Use dedicated
low-balance keys and the smallest provider-supported amount.

1. Run SDP locally with a dedicated local Postgres database and Redis, a
   mainnet RPC, a production project, and Earn enabled.
2. Keep `EARN_VAULT_FEE_SPONSORSHIP_ENABLED=false` and Kora URLs unset. Treasury
   deposits then use the custody wallet as fee payer. Northstar uses
   `DEMO_FEE_PAYER_PRIVATE_KEY` as the explicit partner fee payer.
3. Configure Northstar with `SOLANA_CLUSTER=mainnet-beta`, the same mainnet RPC,
   and an `sk_live_` key from that local production project.
4. Fund only the dedicated Treasury wallet and Northstar owner/fee-payer
   addresses. Prepare and review a tiny USDC deposit, approve execution, then
   verify the completed operation and position. Prepare a withdrawal, review its
   current terms and verify final settlement. For a queue canary, also verify
   request restoration and post-deadline share recovery.

The app verifies the RPC genesis hash before reading balances or building a
transaction. It also refuses to select a strategy from the wrong cluster.

## Local end-to-end notes

- Run SDP through a root Doppler-wrapped command such as `pnpm dev`.
- Keep the SDP database and Redis overrides pointed at `127.0.0.1` for local
  development.
- Keep the local `experimental` release channel, which runs Earn.
- Use an API key from the exact sandbox project selected in the SDP dashboard.
- Restart Northstar after changing `.env.local`.
- Positions in strategies other than the featured one are hidden. Set
  `DEMO_STRATEGY_ID` to the strategy you deposited into if a balance seems to
  be missing.
- Wait for an operation to show `Completed` before treating the payout as
  delivered. Approval, submission and provider settlement remain separate states.
  Refreshing or closing the page does not cancel accepted work.

## Validation

From the repository root:

```bash
pnpm -C examples/embedded-yield-bank test
pnpm -C examples/embedded-yield-bank typecheck
pnpm -C examples/embedded-yield-bank lint
pnpm -C examples/embedded-yield-bank build
```

Basic auth protects the demo from casual public access, but the in-process
private-key signer is demonstration infrastructure, not production custody.
Mainnet mode is intended only for a tightly controlled readiness canary.
