# sdp-metrics-api

Flask API serving Solana RPC counts and transfer data, backed by Delta tables in S3, using Polars as the data framework.

## Endpoints

- `GET /healthz` — liveness check. Never touches S3.
- `GET /rpc` — transaction count for one SPL mint over a lookback window, cached as a Delta table on S3 (see below).
- `GET /rpc/series` — per-day counts for the same mint, for plotting. Takes the same query string as `/rpc`. Deliberately a separate route: `/rpc`'s body *is* the `rpc_counts` Delta schema and cannot grow fields, whereas this is a read-only view whose shape is not a table, so it is not cached to Delta.
- `GET /rpc/transfers` — the last N transfers for a mint with amounts and counterparties, cached as a Delta table on S3 (see below).
- `POST /insert?table_name=X` — writes a JSON payload to S3 as a Delta table (Databricks-readable). Accepts either a bare array or `{"data": [...]}`; `mode` is `append` (default) or `overwrite`.

### Writes and overrides are gated

Assume this service can be reached over a network, so:

- `POST /insert` requires an `X-API-Token` header matching `API_WRITE_TOKEN`. With that unset it answers `503`.
- `table_name` must start with `INSERT_TABLE_PREFIX` (default `dev.mlh.`) and use dots only.
- `?rpc=` is rejected unless `ALLOW_RPC_URL_OVERRIDE=true`, because it makes the server connect to a caller-supplied URL.

Reads stay open. `/insert` also answers `503` until `S3_INSERT_BUCKET` is set; without a bucket, `/rpc` still answers but every call is a live read.

### `GET /rpc`

Counts the signatures for one SPL mint over a lookback window.

| param            | default               | notes                                             |
| ---------------- | --------------------- | ------------------------------------------------- |
| `mint`           | `config.DEFAULT_MINT` | SPL mint address                                  |
| `cluster`        | `devnet`              | `devnet` / `mainnet-beta` / `testnet`             |
| `days`           | `30`                  | 1-365                                             |
| `refresh`        | off                   | `true` bypasses the cache                         |
| `include_failed` | off                   | counts failed txs; never cached (see below)       |
| `rpc`            | cluster default       | overrides the RPC URL; off unless `ALLOW_RPC_URL_OVERRIDE=true` |

The response body **is** the `dev.mlh.rpc_counts` Delta schema, so `insert_rpc.py`
appends it verbatim. Changing these keys changes the table:

| column             | type                           |
| ------------------ | ------------------------------ |
| `mint`             | str                            |
| `cluster`          | str                            |
| `days`             | i64                            |
| `transactionCount` | i64                            |
| `since`            | str (`%Y-%m-%dT%H:%M:%S.000Z`) |

Cache state is reported in the `X-Cache: HIT|MISS` response header rather than in
the body, which keeps the body byte-for-byte the table schema. A cache write that
fails (no AWS credentials, say) is logged and the request still succeeds — it just
costs a live RPC read next time. `include_failed` changes the count but is not one
of the columns, so those calls are answered live and never cached.

### `GET /rpc/transfers`

Returns recent transactions for one mint, each classified from its token balance changes as `transfer`, `mint`, `burn` or `no_movement`. `kind: null` means not resolved yet.

| param                  | default         | notes                                                 |
| ---------------------- | --------------- | ----------------------------------------------------- |
| `mint`                 | required        | base58 address. `token_address` is an alias           |
| `cluster`              | `devnet`        | same values as `/rpc`                                 |
| `limit`                | `100`           | 1-1000                                                |
| `refresh`              | off             | `true` goes to the chain even if the cache could answer |
| `enrich`               | on              | `false` returns signatures only, with no `getTransaction` calls |
| `rpc`                  | cluster default | off unless `ALLOW_RPC_URL_OVERRIDE=true`              |

The cache answers (`X-Cache: HIT`, `source: "s3"`) when it holds a full page, or when this process checked the chain for the mint within `TRANSFER_CACHE_TTL_SECONDS`. That second test is held in memory per worker, so a restart or another worker costs one extra check.

Each request resolves at most `ENRICH_BUDGET` rows, so a large page fills in over several requests. `resolved` says how many rows have an answer, which tells you whether a volume total is complete. Open rows are filled on later requests, including when the cache answers.

The table is append-only: a signature first written unresolved is written again with its amount, and reads return the better row. A failed cache write adds `cache_error` and `X-Cache-Write: failed`, and the reply still returns the transfers.

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # edit S3_INSERT_BUCKET / AWS_REGION
set -a && source .env && set +a
.venv/bin/python app.py
```

### AWS credentials

Resolved in this order:

1. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (plus optional `AWS_SESSION_TOKEN`), passed straight to Polars as storage options.
2. `AWS_PROFILE`, resolved through boto3 (`pl.CredentialProviderAWS`), which is what makes named and SSO profiles work and refreshes tokens as they expire. An unknown profile fails immediately with botocore's `ProfileNotFound`.
3. Otherwise the default chain — ECS task role, instance profile, `~/.aws/credentials`.

`AWS_PROFILE` must **not** be passed as a `storage_options` key: `object_store` has no such config key, ignores it silently, and then falls through to the EC2 instance-metadata endpoint, turning a typo'd profile name into a confusing IMDS timeout.

## Test

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -v
```

## Docker

```bash
docker build -t sdp-metrics-api -f Dockerfile .
docker run --rm -p 8080:8080 \
  -e S3_INSERT_BUCKET=your-bucket \
  -e AWS_REGION=us-east-1 \
  -e AWS_PROFILE=your-profile \
  -v ~/.aws:/home/metrics/.aws:ro \
  sdp-metrics-api
```
