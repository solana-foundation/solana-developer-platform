# Display prices

Tokens.xyz supplies every SDP wallet USD estimate. Jupiter remains the venue
for executable Earn swaps; its price endpoint is no longer called.

## Cache and quota

Steven confirmed the Tokens limits on October 26: 400 requests per 10 seconds,
1,000 per 60 seconds, per key, with no Retry-After on 429. Snapshot responses
are cached upstream for 60 seconds.
[Thread](https://solana-foundation.slack.com/archives/C0A8Q74B9KP/p1793037737960899).

- Batch up to 250 distinct mints per request, previously 50 with Jupiter.
- Cache prices and confirmed no-market answers for 60 seconds in Redis and
  in each process. `hasMarket: false` or `token: null` confirms an absence;
  these entries never become numeric prices, including zero.
  Importing a shared value preserves its original expiry. Local mint caches
  retain at most 10,000 entries, evict the least recently used, and sweep
  expired entries at most once per TTL rather than on every cache miss.
- Claim each missing mint with a seven-second Redis lease. Other replicas wait
  for the owner's result; an expired owner cannot overwrite a new owner's
  value or release its lease. Omitted, malformed, stale and failed answers
  are never cached. Polling a confirmed unpriceable mint uses one upstream
  request per 60 seconds across replicas, previously one per balance read.
- Reserve each HTTP attempt atomically in Redis, using Redis time and exact
  rolling windows: at most 320 requests per 10 seconds and 800 per minute.
  The 20% headroom covers traffic outside the service and timing variation.
- Limit sockets to two per process. Queued work shares a four-second lookup
  deadline. Redis commands and connection establishment have 250 ms timeouts;
  lease cleanup is awaited and can extend completion by one command timeout.
- On 401, 403 or 429, pause requests across that key's replicas for 60 seconds
  plus jitter. A rotated key has its own namespace and can recover immediately.
  If coordination fails or the quota is exhausted, keep valid cached prices
  and leave other balances unpriced. There is no uncoordinated retry.
  Quota and credential refusals stop upstream work while later batches can
  still read valid prices from Redis without claiming new leases.

Every production replica using a key must use the same Redis backend. Use
separate keys for dev, stage and prod. Local development and CI must not load
test with a deployed environment's key from independent Redis instances.
Other applications consuming that key are outside SDP's limiter; unexpected
429s remain visible and trigger the shared cooldown.

No refresh work is detached after the response. Cloud Run CPU throttling
cannot suspend a background price refresh that another request relies on.

## Data boundary

The request goes to a fixed HTTPS endpoint and refuses redirects. The server
key requires `assets:read`, stays in Doppler/Secret Manager, and is never logged or
stored in Redis. Redis namespaces use HMAC-SHA-256 with the provider key and
a fixed display-pricing context. Replicas sharing a key derive the same
namespace; separate keys isolate their quotas. Stored values contain public
mint prices, not wallets or tenant data.

Responses have a 1 MiB cap. Only requested, matching mint addresses with
positive finite prices and `hasMarket: true` are eligible. Conflicting
duplicates, missing timestamps, timestamps more than one minute ahead, and
snapshots older than two hours are excluded. Cached entries are checked again
before being returned. Stablecoins retain their observed price, including
depegs; SDP does not substitute a dollar.

The two-hour bound accommodates hourly curated snapshots. It does **not**
prove price freshness: Tokens' source selector can pair a fallback price with
a newer snapshot timestamp. This is a known upstream limitation. Display
prices must never set transfer amounts, swap floors, collateral values,
accounting marks or token fees. Executable swap quotes remain separate.

## Runtime setup

Set `TOKENS_XYZ_API_KEY` in the SDP Doppler config. For Cloud Run, mirror it to
`sdp-<env>-app-tokens-xyz-api-key` and enable
`sdp_api_tokens_xyz_key_ready` only after the real secret version exists.
[Infrastructure PR #292](https://github.com/solana-foundation/sdp-infra/pull/292)
includes dev, stage and prod wiring; image deployment alone does not import
Doppler secrets.

`JUPITER_PRICE_API_KEY`, `JUPITER_PRICE_API_URL` and the Tokens shadow flag have
been removed. `JUPITER_SWAP_API_KEY` and Kora's separate key retain their
existing roles. Kora currently runs free sponsorship with no SPL-paid tokens.

Swap quotes (`/swap/v2/order`) and builds (`/swap/v2/build`) require
`JUPITER_SWAP_API_KEY` and send it as `x-api-key`, following
[Jupiter's production guidance](https://developers.jup.ag/docs/swap).
That key is never used for display prices; the Tokens key is never sent to
Jupiter. On October 26 the Jupiter swap key was present in dev and stage
configs but absent in `prd`. Before enabling production swaps, add the key
there, sync `sdp-prod-app-jupiter-swap-api-key`, and enable
`sdp_api_jupiter_swap_key_ready`. The infrastructure PR includes that mount.

## Ticket acceptance

PRO-1977's earlier Jupiter-primary/fallback plan is superseded by the
October 26 instruction to use Tokens for every display price. Cache sharing,
batching, quota enforcement, configuration and provider telemetry are local
implementation work. Before production rollout, verify Secret Manager mounts
and stage wallet coverage using the new revision.

Main pushes auto-deploy the API. Merge its PR only after Tokens mounts are
applied and verified in every target environment. Infra #292 now contains
credential preparation; stage Kora metrics, operational alerts, and dashboards
follow as separate stacked PRs. Deploy API telemetry before the new operational
alerts and API/RPC dashboards, which publish to Grafana when merged. Follow
infra's `docs/runbooks/tokens-pricing-rollout.md` for the release order.

The ticket's future money-decision requirements remain prerequisites for any
new valuation-based money path: executable/fresh quotes, independent sources,
per-asset trust and depeg checks. This change adds no such path.

PRO-1711's inventory and alert coverage live in sdp-infra's
`kora/SIGNAL_INVENTORY.md`. Static validation does not close its remaining
live Grafana, stage scrape, Kora ingress and Sentry verification requirements.

## Local verification, October 26

- Separate dev, stage and prod credentials each returned HTTP 200.
- The application priced all 14 well-known mainnet mints. Fifty concurrent
  lookups shared one upstream request (325 ms); a second process reused Redis
  with zero upstream requests (42 ms). Warm reads took less than 1 ms.
  These are individual smoke-test observations, not production latency bounds.
- Focused regression suites: 140 API pricing, wallet and telemetry tests;
  56 swap tests; 20 web tests. API/web typechecks, Biome, module boundaries
  and value-movement checks passed.
- Jupiter dev and stage keys each returned a live unsigned quote through the
  application's swap client. Production was not queried without its key.
- Public docs regenerated; 266 Markdown links and 27 external URLs passed.
- Infra: 148 inventoried signals, 164 alert rules and four contact points
  validated. Terraform 1.7.5 validated dev, stage and prod without a backend.
  Dev required adding the missing Linux provider checksum in a disposable
  copy; checked-in provider versions and lockfiles were unchanged.

The full local workspace suite passed all 26 test tasks using CI's Node
24.22.1 with caching disabled: all 8,217 API tests, 3,397 web tests, 197 RPC
tests, and the other 23 workspace tasks passed. Ten opt-in live tests retained
their existing skips. All 245 root script tests passed. Workspace typechecking
passed all 28 tasks.

Full Biome reported 26 SVG title errors in files unchanged from main. Local
integration setup stopped on an existing
`earn_movements_kamino_deposit_receipt_check` constraint. These remain local
verification gaps; the focused checks above passed.

No rollout, live Grafana check or local browser E2E was run.
