# Display prices

Tokens.xyz supplies every SDP wallet USD estimate. Jupiter remains the venue
for executable Earn swaps; its price endpoint is no longer called.

## Cache and quota

Steven confirmed the Tokens limits on October 26: 400 requests per 10 seconds,
1,000 per 60 seconds, per key, with no Retry-After on 429. Snapshot responses
are cached upstream for 60 seconds.
[Thread](https://solana-foundation.slack.com/archives/C0A8Q74B9KP/p1793037737960899).

- Batch up to 250 distinct mints per request, previously 50 with Jupiter.
- Cache successful values for 60 seconds in Redis and in each process.
  Importing a shared value preserves its original expiry. Local mint caches
  retain at most 10,000 entries, evict the least recently used, and sweep
  expired entries at most once per TTL rather than on every cache miss.
- Claim each missing mint with a seven-second Redis lease. Other replicas wait
  for the owner's result; an expired owner cannot overwrite a new owner's
  value or release its lease. Failed and missing prices are never cached.
- Reserve each HTTP attempt atomically in Redis, using Redis time and exact
  rolling windows: at most 320 requests per 10 seconds and 800 per minute.
  The 20% headroom covers traffic outside the service and timing variation.
- Limit sockets to two per process. Queued work shares a four-second lookup
  deadline. Redis commands and connection establishment have 250 ms timeouts;
  lease cleanup is awaited and can extend completion by one command timeout.
- On 429, pause requests across that key's replicas for 60 seconds plus jitter.
  If coordination fails or the quota is exhausted, keep valid cached prices
  and leave other balances unpriced. There is no uncoordinated retry.

Every production replica using a key must use the same Redis backend. Use
separate keys for dev, stage and prod. Local development and CI must not load
test with a deployed environment's key from independent Redis instances.
Other applications consuming that key are outside SDP's limiter; unexpected
429s remain visible and trigger the shared cooldown.

No refresh work is detached after the response. Cloud Run CPU throttling
cannot suspend a background price refresh that another request relies on.

## Data boundary

The request goes to a fixed HTTPS endpoint and refuses redirects. The server
key has `assets:read`, stays in Doppler/Secret Manager, and is never logged or
stored in Redis. Redis keys contain a SHA-256 fingerprint. Stored values
contain public mint prices, not wallets or tenant data.

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
The local infra branch includes dev, stage and prod wiring; image deployment
alone does not import Doppler secrets.

`JUPITER_PRICE_API_KEY`, `JUPITER_PRICE_API_URL` and the Tokens shadow flag have
been removed. `JUPITER_SWAP_API_KEY` and Kora's separate key retain their
existing roles. Kora currently runs free sponsorship with no SPL-paid tokens.

## Ticket acceptance

PRO-1977's earlier Jupiter-primary/fallback plan is superseded by the
October 26 instruction to use Tokens for every display price. Cache sharing,
batching, quota enforcement, configuration and provider telemetry are local
implementation work. Before production rollout, verify Secret Manager mounts
and stage wallet coverage using the new revision.

The ticket's future money-decision requirements remain prerequisites for any
new valuation-based money path: executable/fresh quotes, independent sources,
per-asset trust and depeg checks. This change adds no such path.

PRO-1711's inventory and alert coverage live in sdp-infra's
`kora/SIGNAL_INVENTORY.md`. Static validation does not close its remaining
live Grafana, stage scrape, Kora ingress and Sentry verification requirements.
