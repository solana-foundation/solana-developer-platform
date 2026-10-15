# Overview network figures

The dashboard Overview's "Solana network" block shows four chain-wide readings
from data.solana.com, the API behind solana.com/data, and the mainnet cluster's
health from status.solana.com. sdp-api is the only caller of either; the
browser reads SDP's own route.

## Flow

| Step | Where | Does |
| -- | -- | -- |
| Hook | `apps/sdp-web/src/app/dashboard/[projectId]/overview-network.data.ts` | `useOverviewNetwork`: SWR, refetch every 5 min, last snapshot kept in local storage for an instant paint |
| Proxy | `apps/sdp-web/src/app/api/dashboard/network/route.ts` | `proxyToSdpApi` to the route below |
| Route | `apps/sdp-api/src/routes/internal-network/` | `GET /internal/dashboard/network`, Clerk sessions only, outside OpenAPI |
| Service | `apps/sdp-api/src/services/network/network.service.ts` | Joins the readings cache and the health cache into one snapshot |
| Recipes | `apps/sdp-api/src/services/network/network-snapshot.ts` | `NETWORK_READINGS`: each reading's inputs and same-day math |
| Client | `apps/sdp-api/src/lib/data-api/` | Reads `/v1/metrics?provider=preferred`, validates it, indexes it by metric and closed UTC day |
| Contract | `packages/sdp-types/src/network-metrics.ts` | The snapshot both apps parse |

## Reading data.solana.com

Every read is `/v1/metrics?provider=preferred`: the data team's pick for each
metric, one value per metric and UTC day for the past year (about 1.1 MB and
9.5k rows, values as decimal strings). Every provider's rows would be five times
that and disagree by more than 10% on a day, so SDP reads no others. The API has no
metric or date filter, no compression and no ETag, so a read is the whole
dataset; parsing all of it takes about 8 ms. A row that fails validation, or a
second value for a metric's day, is dropped and logged. A failed, timed-out,
oversized (past 4 MB) or truncated read answers 503. `lib/provider-json.ts`, the
API's one client for third-party JSON outside the ramps (Google Places uses it
too), maps every way a provider fails to answer and logs the provider's wording
and the schema's issue paths, never their values.

## Closed days

The API's newest day is still in progress, and its values keep moving until it
closes. A row dated on the response's `generatedAt` UTC day or later is left out
(`indexMetricRows` in `lib/data-api/metrics.ts`), so every figure is a closed
day's, judged by the copy's own clock rather than SDP's.

- A reading's points are the days all its inputs reported.
- The snapshot's `asOf` is the newest day, within two days of the freshest
  point, that the most readings have a point on. Every series ends there, so
  every headline is the same day's figure while one provider's day has yet to
  land.
- A reading with no point on `asOf` (stale, or a gap that day) shows as
  unavailable rather than holding the others back.

The newest point is therefore usually yesterday's close: the preferred value
for that day.

## Caching

`lib/refreshing-cache.ts` keeps each value in memory and shares a copy through
the KV `cache` store (Redis):

| Value | Fresh for | Served while refreshing | Retry after a failure |
| -- | -- | -- | -- |
| Readings (`cache:network:readings:v2`) | 3 hours | up to 48 hours old | 5 minutes |
| Health (`cache:network:health:v2`) | 2 minutes | up to 3 minutes old | 1 minute |

- A stale copy answers at once while one refresh runs behind it; a request only
  waits when no copy can be served. That refresh goes to the request's
  background runner (`executionCtx.waitUntil`), so a shutdown drains it instead
  of cutting it off with its refresh claim still held.
- Concurrent requests share one read. Past fresh, an instance reads the shared
  copy before serving its own or its last failure, and adopts it when newer; only
  the instance holding the refresh claim reads the source while a servable copy
  exists.
- A failure is never stored, and a failing source is not asked again until the
  retry delay passes.
- With nothing cached anywhere (a cold start), an instance that loses the
  refresh claim waits for the claimer's copy, up to its own source's deadline
  plus a margin (25 seconds for the readings, 5 for health), rather than reading
  the source too.
- A store that fails costs only the sharing: the instance carries on with its
  own copy and the source, and logs each failed call.

Net effect: about one data.solana.com read every 3 hours across all instances,
whatever the traffic. Its CDN keeps each copy for hours (an `s-maxage` of 3 to
12 hours when checked), so reading more often mostly downloads the same 1.1 MB
again. The route is not metered for the same reason.

## Scale

User traffic never reaches data.solana.com: every request reads the cache. On
the real payload, 20,000 concurrent requests took 94 µs each (mostly encoding
the 58 KB response) and read the source once. Browsers refetch on load and every
5 minutes while the tab is visible, so an open Overview costs about a dozen
cached requests an hour.

What would shrink each read is on the data team's side: gzip (1.1 MB to
100 KB) and a metric filter (the five metrics SDP reads are 215 KB); both
together bring a read to about 20 KB.

## In the Overview

- Supply charts its daily values. Transfers, share and cost swing 30% or more
  with the weekday, so they chart their 7-day average (each day's on 30D and
  90D, one point a week on 1Y), marked "7d avg". The headline and the change
  read the drawn line, so the number, the line's end and the % always agree
  (`networkRangePoints` in `network-stats.ts`).
- The header shows the age since `asOf`'s close ("14h ago", "40h ago"),
  counted in the browser. Past three days it shows "As of <date>" in amber.
- The badge maps status.solana.com's "Mainnet Beta - Cluster" component to
  Healthy, Degraded, Outage or Maintenance. Each reading carries `checkedAt`;
  one more than 10 minutes old is dropped, even on a page left open while
  refreshes fail, and a failed read shows no badge. The API serves a reading
  at most 3 minutes old and the page refetches every 5, so while refreshes
  work the badge never lapses: keep that sum under 10 when changing either.
- With no snapshot each figure reads "Unavailable" in its place; the block
  never shows an old figure as current.
- Every state (loading, unavailable, a reading with nothing to chart) keeps the
  ready layout's height, and the header keeps its rows at any width, so nothing
  on the page moves when the figures or the badge arrive or fail.

## Adding a reading

1. Add its id to `NETWORK_METRIC_IDS` in `@sdp/types/network-metrics`.
2. Add its recipe to `NETWORK_READINGS`: the data.solana.com metric names it
   reads and how they combine.
3. Add its copy, format and unit in `overview-network.tsx` and
   `NETWORK_METRIC_DISPLAY`.
4. Bump the readings cache key in `network.service.ts` and
   `NETWORK_SNAPSHOT_VERSION` in `overview-network.data.ts`: the snapshot's
   metrics now hold one more key, and a copy saved without it would fail to
   parse.

The types fail until the first three exist. A new reading rides the same read;
a separate product built on these metrics gets its own refreshing cache, and
with it a read of its own each refresh.

## Config and operations

- `DATA_API_KEY` (Doppler `dev` and `stg`; production needs it in sdp-infra).
- Logs: `sdp_api_data_api_read` on every upstream read, with the API's
  `generatedAt`; `sdp_api_data_api_rows_rejected`; `sdp_api_provider_error` and
  `sdp_api_provider_response_invalid`; `sdp_api_refreshing_cache_store_failed`;
  and `sdp_api_vendor_call` failures for vendors `solana-data` and
  `solana-status`.
- Locally, delete the Redis key `cache:network:readings:v2` and restart the API
  to force a fresh read.
