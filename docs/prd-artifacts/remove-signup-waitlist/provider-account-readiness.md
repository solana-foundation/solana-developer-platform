# Shared provider account readiness

Research date: 2026-07-21

This is the exhaustive external-account inventory derived from the API runtime bindings and provider
registries. It lists integrations the repository can use; it does not prove that each credential is
deployed or identify the current commercial plan. Fill the `Deployed plan / owner` column from the
actual vendor consoles and contracts before rollout.

## Launch account worksheet

| Priority | Account | Proposed access | Public ceiling or sandbox constraint | Required action | Deployed plan / owner |
| --- | --- | --- | --- | --- | --- |
| P0 | Clerk | Platform dependency | Hobby includes 50,000 monthly retained users per app and 3 dashboard seats | Verify production instance, organization limits, webhook delivery, and signup restriction removal | TBD |
| P0 | Cloudflare Workers, Hyperdrive, and 4 KV namespaces | Platform dependency | Deployment-plan specific | Record Workers CPU/request, Hyperdrive connection, KV read/write/storage quotas, alerts, and upgrade path | TBD |
| P0 | Postgres database | Platform dependency | Vendor cannot be identified from `DATABASE_URL`/Hyperdrive binding | Identify vendor/plan; verify connections, storage, backup, and autoscaling limits | TBD |
| P0 | Redis | Platform dependency | Vendor cannot be identified from `REDIS_URL` | Identify vendor/plan; verify commands, memory, connections, eviction, and availability | TBD |
| P0 | Default Solana RPC | General | Endpoint/provider cannot be identified from `SOLANA_RPC_URL` | Identify account, devnet RPS, monthly allowance, overage, and failover | TBD |
| P0 | Alchemy | General | Free: 30M compute units/month and about 25 RPS; PAYG raises throughput and meters CUs | Record plan, devnet CU cost, throughput, overage, and alerting | TBD |
| P0 | Helius | General | Free: 1M credits/month and 10 RPC RPS; paid tiers raise both | Verify key/plan; set credit and RPS alerts; forecast per-organization RPC load | TBD |
| P0 | QuickNode | General | Trial: 10M API credits and 15 RPS; paid plans range from 50 to 500 RPS before custom enterprise | Record plan, Solana multipliers, endpoint/network, backend-use terms, and upgrade path | TBD |
| P0 | Triton | General | PAYG requires $125 minimum prepaid deposit; standard RPC is $10/M calls plus $0.08/GB | Verify balance, connection/RPS settings, devnet coverage, refill alert, and backend-use permission | TBD |
| P0 | Validation Cloud | General | Free covers first 50M CU/month; Scale is usage based; Private is custom | Record plan, method-specific limits, devnet coverage, billing, and alerts | TBD |
| P0 | Privy | General | Developer: up to 500 MAU, 50k signatures/month, and $1M monthly transaction volume | Confirm plan and whether SDP's shared-account model is permitted; alert on all three meters | TBD |
| P0 | Coinbase CDP wallets | General | First 5,000 wallet operations/month free, then $0.005/operation; 500 writes and 600 reads per 10s | Enable billing/budget alerts; count creates, signs, sends, and policies | TBD |
| P0 | Para | General | Free: 1,200 MAU and 30 REST req/min; Growth: 10k MAU and 1,000 req/min; Scale has custom API usage | Confirm Beta project capacity, project/wallet ownership terms, MAU meter, and custom-limit path | TBD |
| P0 | Turnkey | General | Free: 100 wallets and 25 transactions/month; PAYG: 1,000 wallets; Pro: 2,000; Enterprise custom | Move off free before open signup or enforce a launch wallet cap | TBD |
| P0 | Resend | Platform dependency | Free: 3,000 emails/month and 100/day; Pro starts at 50k/month with overage | Verify plan and sender reputation; alert on quota, bounce, and webhook failures | TBD |
| P0 | Sentry | Platform dependency | Plan and event quota not identifiable from DSN | Record error/span/replay quotas and overage; review trace sample rate | TBD |
| P0 | Google Places/Maps | Platform dependency | Autocomplete Requests: first 10k/month free, then usage pricing; quotas are per method/project | Verify billing project, daily budget, API restrictions, and quota alerts | TBD |
| P0 | GCP Secret Manager | Platform dependency | Usage priced by active secret versions and access operations | Verify project billing, access quota, secret-version growth, IAM, and alerts | TBD |
| P0 | MoonPay | General | REST: 350 requests/10s for quote/price routes, 30 RPS otherwise; partner subscription is required | Confirm sandbox and live partner plan, supported Solana test environment, domains, and higher-limit path | TBD |
| P0 | Lightspark Grid | General | Sandbox/test access exists; public Grid quota and pricing were not found | Obtain sandbox rate policy, customer/account caps, compliance obligations, transaction pricing, and production agreement | TBD |
| P0 | BVNK | General | Sandbox is separate and production access is requested through the portal; public quota not found | Confirm sandbox customer/wallet/rule caps, Sumsub/KYC behavior, supported Solana rails, pricing, and production approval | TBD |
| P0 | MoneyGram xRamps sandbox | General | Repository supports sandbox only; public quota/pricing not found | Confirm pilot contract, sandbox session/quote limits, test liquidity, and production path | TBD |
| P0 | Coinbase Onramp | General | Trial mode is limited; full access requires onboarding; quote APIs are 10 RPS per app ID | Complete onboarding, record trial limits, guest-checkout limits, fees, and full-access owner | TBD |
| P0 | Mural Pay | General | Sandbox requires contacting Mural; one business organization; test funds are replenished by support; bank deposits cap near $5k | Confirm whether SDP's many organizations may share one sandbox business org, customer caps, rate limits, and contract | TBD |
| P0 | Stripe crypto onramp | General | Onramp requires an approved application even for sandbox; currently public preview | Confirm account approval, sandbox access, country/network coverage, API limits, and pricing | TBD |
| P1 | Kora fee payment | Manual pending review | SDP points at a hosted devnet Kora by default; sponsored fees consume the operator fee-payer balance | Confirm operator/contract, authentication, RPS, max spend, refill owner; enable per-wallet usage limits | TBD |
| P1 | MagicBlock Private Payments | Manual pending review | Public pricing lists 0.002 SOL plus 0.1% per Solana-mainnet private payment; no public API quota | Confirm devnet/private-ER allowance, auth-token sharing, rate limit, and contract | TBD |

P0 means capacity must be understood before open signup. Kora and MagicBlock remain P1 while their
general/manual classification is unresolved.

## Manual custody/signing providers

| Account | Public ceiling or contract signal | Activation readiness action | Deployed plan / owner |
| --- | --- | --- | --- |
| Fireblocks | Developer Sandbox has low, workspace-specific limits; increases require support and may cost. SDP creates a vault account for each Fireblocks wallet path. | Confirm workspace type, API-user/vault-account ceilings, request limits, testnet access, upgrade lead time, and 429 backoff | TBD |
| Dfns | Starter: 100 wallets, 100 signatures/month, 60 req/min; larger plans increase wallets/signatures/RPM | Record actual plan, wallets, signatures, requests, test environment, and upgrade quote | TBD |
| IBM Digital Asset Haven | Trial/Starter: up to 50k wallets and $100M monthly outbound volume; Enterprise: unlimited wallets and $500M. Trial is 30 days. | Confirm whether current access is Trial/Starter, expiration, API rate limits, third-party integrations, and support upgrade | TBD |
| Anchorage | 20 requests/sec per organization shared across keys; other quotas/pricing are contractual | Confirm wallet/account limits, sandbox terms, support/contract owner, and backoff | TBD |
| Utila | Starter: 1,000 active wallets, 1 vault, 3 users, and $3M outbound volume/quarter | Confirm active-wallet counting, subwallet model, devnet support, volume handling, and higher-plan quote | TBD |

`local` signing is intentionally absent: it is not a vendor account and should remain self-hosted or
internal in managed SDP.

## Manual compliance providers

| Account | Public ceiling or contract signal | Activation readiness action | Deployed plan / owner |
| --- | --- | --- | --- |
| Range | Trial Risk API: 10 requests/month; enterprise is custom | Obtain enterprise sandbox/test allowance, price per screen, hard-stop behavior, and contract owner | TBD |
| Elliptic | Global default: 500 req/min; synchronous wallet endpoint used by SDP: 15 req/sec | Confirm included screens/overage and add endpoint-specific throttling/backoff | TBD |
| TRM | SDP uses paid `/public/v2/screening/addresses`; public Sanctions API allowances do not establish this contract's quota | Obtain order form, sandbox vs production restrictions, included screens, RPS, overage, and lead time | TBD |
| Chainalysis | Risk API pricing and quota are not public | Obtain sandbox access, included screens, RPS, overage, data-use terms, and contract owner | TBD |

One SDP compliance action currently calls every enabled provider in parallel. Decide whether the
product needs one selected compliance provider, an ordered fallback, or multi-provider fan-out; the
current fan-out multiplies cost and rate-limit pressure.

## External accounts that are configured but not provider choices

These do not need manual-provider cards, but their shared quotas can still block open signup:

- Solana devnet faucet/fee-payer wallets and any mainnet fee-payer wallet
- Clerk webhook endpoint/signing secret
- Resend sending domain and API key
- Sentry API and web projects/DSNs
- Google Cloud project for Places and Secret Manager
- Cloudflare account, Worker deployment, Hyperdrive configuration, and KV namespaces
- backing Postgres and Redis accounts
- ramp webhook configurations for MoonPay, Lightspark, BVNK, Mural, Coinbase, and Stripe

## Per-account data to collect

For every row, record:

- vendor account/workspace/project ID and separate sandbox/production credentials
- commercial plan, contract/order-form link, renewal/expiry, owner, and support contact
- included and hard maximum wallets, users/MAU, signatures, screens, transactions, volume, storage,
  requests, RPS, and concurrent connections
- whether test/devnet use is free, metered, time-limited, or contract-limited
- overage price, 429/hard-stop behavior, upgrade lead time, and emergency increase path
- current usage, 50/75/90% alerts, per-organization attribution, and kill switch
- whether SDP may serve multiple unrelated customer organizations from one vendor account

## Primary sources

- [Clerk pricing](https://clerk.com/pricing)
- [Resend pricing](https://resend.com/docs/knowledge-base/what-is-resend-pricing)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Privy pricing](https://www.privy.io/pricing)
- [Coinbase CDP wallet pricing](https://docs.cdp.coinbase.com/wallets/pricing-and-rewards/overview)
- [Coinbase CDP rate limits](https://docs.cdp.coinbase.com/api-reference/v2/rate-limits)
- [Turnkey pricing](https://www.turnkey.com/pricing)
- [Helius plans](https://www.helius.dev/docs/billing/plans)
- [Triton pricing](https://www.triton.one/pricing/)
- [MoonPay FAQ and limits](https://dev.moonpay.com/widget/faqs)
- [Stripe crypto onramp](https://docs.stripe.com/crypto/onramp)
- [Kora fees and operator risk](https://solana.com/docs/tools/kora/operators/fees)
- [Kora usage limits](https://solana.com/docs/tools/kora/beta/configuration)
- [MagicBlock pricing](https://docs.magicblock.gg/pages/overview/additional-information/pricing)
- [Fireblocks rate limits](https://developers.fireblocks.com/reference/rate-limiting)
- [Fireblocks workspaces](https://developers.fireblocks.com/docs/workspace-environments)
- [Para pricing](https://www.getpara.com/pricing)
- [Para REST limits](https://docs.getpara.com/v2/rest/setup)
- [Dfns pricing](https://dfns.co/pricing)
- [IBM Digital Asset Haven plans](https://www.ibm.com/docs/en/daw/1.2.x?topic=haven-subscription-plans)
- [Anchorage API limits](https://docs.anchorage.com/knowledge-base/api-reference/errors-pagination)
- [Utila pricing](https://utila.io/pricing)
- [Range Risk API limits](https://docs.range.org/risk-api/product-info/rate-limits)
- [Elliptic limits](https://developers.elliptic.co/docs/copy-of-conventions-and-limits)
- [TRM Sanctions API](https://docs.sanctions.trmlabs.com/)
- [Alchemy pricing](https://www.alchemy.com/docs/reference/pricing-plans)
- [QuickNode pricing](https://www.quicknode.com/pricing)
- [Validation Cloud Solana pricing](https://www.validationcloud.io/solana)
- [Lightspark Grid concepts](https://docs.lightspark.com/api-reference/terminology)
- [BVNK sandbox API](https://docs.bvnk.com/bvnk/api-explorer/api-overview/overview/)
- [Coinbase Onramp overview](https://docs.cdp.coinbase.com/onramp/onramp-overview)
- [Mural sandbox](https://developers.muralpay.com/docs/sandbox-environment)
