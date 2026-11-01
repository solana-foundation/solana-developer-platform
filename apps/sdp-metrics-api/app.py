"""Flask entry point for the SDP metrics API.

Every env-derived path and credential comes from config.py, which is also what
insert.py / rpc_cache.py read, so a request can never resolve one
location while the cache writes another.
"""

import hmac
import re
import time
from collections import OrderedDict

from flask import Flask, jsonify, request

from config import (
    ALLOW_RPC_URL_OVERRIDE,
    API_WRITE_TOKEN,
    CLUSTER_RPC,
    DEFAULT_CLUSTER,
    DEFAULT_DAYS,
    DEFAULT_MINT,
    DEFAULT_TRANSFER_LIMIT,
    ENRICH_BUDGET,
    INSERT_BUCKET,
    INSERT_TABLE_PREFIX,
    MAX_TRANSFER_LIMIT,
    RPC_TABLE_NAME,
    TRANSFER_CACHE_TTL_SECONDS,
    TRANSFERS_TABLE_NAME,
)
from insert import insert_delta
from rpc import (
    Options,
    count_recent_transactions,
    daily_transaction_counts,
    format_timestamp,
)
from rpc_cache import read_cached
from transfer_cache import (
    TRANSFER_TABLE_SCHEMA,
    cached_signatures,
    read_cached_transfers,
    unresolved_signatures,
)
from transfers import enrich_transfers, fetch_transfers

app = Flask(__name__)

# The /rpc response is the rpc_counts table's schema, verbatim. insert_rpc.py
# aborts if these drift apart, so any change here is a change to the table.
RPC_SCHEMA = ("mint", "cluster", "days", "transactionCount", "since")

MAX_DAYS = 365

# Base58, the length of an ed25519 public key. A mint from the query string becomes
# a key in the table below and a value in the Delta cache, so junk stops here.
MINT_PATTERN = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")

# When the chain was last consulted, keyed by (mint, cluster). A quiet token's rows
# stop being written once they are cached and resolved, so the age of its newest
# row cannot say whether it is current, only when it last changed. "How recently
# did we check" is a fact about this process, so it lives here: losing it on restart
# costs one re-check per mint. Bounded because the keys come from the caller.
#
# A check also records how much it covered. A check for 1 row says nothing about
# the next 99, so it only vouches for a larger page if it reached the end of the
# mint's history.
MAX_TRACKED_MINTS = 10_000
_last_chain_check = OrderedDict()


def _record_chain_check(mint, cluster, covered, exhausted):
    _last_chain_check[(mint, cluster)] = (time.time(), covered, exhausted)
    _last_chain_check.move_to_end((mint, cluster))
    while len(_last_chain_check) > MAX_TRACKED_MINTS:
        _last_chain_check.popitem(last=False)


def _chain_check(mint, cluster, limit):
    """Seconds since the last check, and whether it vouches for `limit` rows."""
    seen = _last_chain_check.get((mint, cluster))
    if seen is None:
        return None, False
    checked_at, covered, exhausted = seen
    age = time.time() - checked_at
    return age, age <= TRANSFER_CACHE_TTL_SECONDS and (exhausted or covered >= limit)


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


def _parse_rpc_args(args):
    """Validate /rpc's query string, returning (Options, error_message)."""
    mint = (args.get("mint") or DEFAULT_MINT).strip()
    if not mint:
        return None, "mint must not be blank"

    cluster = (args.get("cluster") or DEFAULT_CLUSTER).strip()
    if cluster not in CLUSTER_RPC:
        return None, f"cluster must be one of {', '.join(sorted(CLUSTER_RPC))}"

    raw_days = args.get("days")
    if raw_days is None or raw_days == "":
        days = DEFAULT_DAYS
    else:
        try:
            days = int(raw_days)
        except ValueError:
            return None, "days must be an integer"
        if not 1 <= days <= MAX_DAYS:
            return None, f"days must be between 1 and {MAX_DAYS}"

    # An explicit `rpc` override reaches urlopen directly, so a caller could
    # point this server at internal addresses. Off unless explicitly enabled.
    override = (args.get("rpc") or "").strip()
    if override and not ALLOW_RPC_URL_OVERRIDE:
        return None, "rpc override is disabled; select a network with cluster"
    rpc_url = override or CLUSTER_RPC[cluster].strip()

    include_failed = (args.get("include_failed") or "").lower() in ("1", "true", "yes")

    return (
        Options(
            mint=mint,
            cluster=cluster,
            days=days,
            rpc_url=rpc_url,
            include_failed=include_failed,
        ),
        None,
    )


@app.get("/rpc")
def get_rpc():
    options, error = _parse_rpc_args(request.args)
    if error:
        return jsonify(error=error), 400

    refresh = (request.args.get("refresh") or "").lower() in ("1", "true", "yes")

    # include_failed changes the count but is not one of the table's columns, so
    # a row written under it would be indistinguishable from a default one.
    # Those calls stay live-only rather than poisoning the shared cache. So do
    # overrides: a count from another RPC would be stored under this cluster's key.
    cacheable = not options.include_failed and not (request.args.get("rpc") or "").strip()

    if cacheable and not refresh:
        cached = read_cached(options.mint, options.cluster, options.days)
        if cached:
            # Cache state rides in a header so the body stays byte-for-byte the
            # rpc_counts schema and insert_rpc.py can pass it through verbatim.
            return jsonify(cached), 200, {"X-Cache": "HIT"}

    try:
        total, _pages, cutoff = count_recent_transactions(options)
    except RuntimeError as exc:
        # An upstream RPC failure is the provider's problem, not a bad request.
        return jsonify(error=str(exc)), 502

    record = {
        "mint": options.mint,
        "cluster": options.cluster,
        "days": options.days,
        "transactionCount": total,
        "since": format_timestamp(cutoff),
    }

    if cacheable:
        try:
            insert_delta(RPC_TABLE_NAME, [record])
        except Exception as exc:  # noqa: BLE001 - cache writes must never fail a read
            # No AWS credentials locally is the common case; the caller still
            # gets a correct answer, it just costs a live RPC read next time.
            app.logger.warning("rpc cache write to %s failed: %s", RPC_TABLE_NAME, exc)

    return jsonify(record), 200, {"X-Cache": "MISS"}


@app.get("/rpc/series")
def get_rpc_series():
    """Per-day transaction counts for one mint, for plotting.

    Deliberately separate from /rpc: that endpoint's body IS the rpc_counts
    Delta schema and must not grow fields. This one is a read-only view for the
    dashboard and is not cached to Delta — its shape is not a table.
    """
    options, error = _parse_rpc_args(request.args)
    if error:
        return jsonify(error=error), 400

    try:
        buckets, _pages, cutoff = daily_transaction_counts(options)
    except RuntimeError as exc:
        return jsonify(error=str(exc)), 502

    return jsonify(
        mint=options.mint,
        cluster=options.cluster,
        days=options.days,
        since=format_timestamp(cutoff),
        series=buckets,
    )


def _transfers_response(payload, cache_status, cache_write=None):
    """Report cache state in headers, so body keys stay facts about the chain."""
    response = jsonify(**payload)
    response.headers["X-Cache"] = cache_status
    # Absent when nothing was written: every signature being cached is a success,
    # not a failed write.
    if cache_write is not None:
        response.headers["X-Cache-Write"] = "ok" if cache_write else "failed"
    return response


def _resolved_count(rows):
    return sum(1 for row in rows if row.get("kind"))


def _write_transfers(rows):
    """Append rows to the cache. Returns False on failure, which never fails a read."""
    try:
        insert_delta(
            TRANSFERS_TABLE_NAME, rows, evolve_schema=True, schema_overrides=TRANSFER_TABLE_SCHEMA
        )
    except Exception as exc:  # noqa: BLE001 - the caller already has a correct answer
        # Logged, not returned: the message can name buckets and paths, and this
        # route needs no credential.
        app.logger.warning("transfer cache write to %s failed: %s", TRANSFERS_TABLE_NAME, exc)
        return False
    return True


@app.get("/rpc/transfers")
def get_rpc_transfers():
    """The last N transfers for a mint, from the Delta cache when it can answer.

    The cache answers when it holds a full page, or when the chain was consulted
    for this mint within TRANSFER_CACHE_TTL_SECONDS. Without the second test a
    token with three transactions could never get a hit, and every load would go
    to the chain for exactly the tokens an issuer wants to measure.

    Separate from /rpc, whose body is the rpc_counts table schema.
    """
    # token_address is accepted because silently ignoring it would answer about
    # the wrong token. There is no default mint for the same reason.
    mint = (request.args.get("mint") or request.args.get("token_address") or "").strip()
    if not MINT_PATTERN.match(mint):
        return jsonify(error="mint must be a base58 address"), 400

    cluster = (request.args.get("cluster") or DEFAULT_CLUSTER).strip()
    if cluster not in CLUSTER_RPC:
        return jsonify(error=f"cluster must be one of {', '.join(sorted(CLUSTER_RPC))}"), 400

    # Same reasoning as /rpc: this makes the server connect to the caller's URL.
    override = (request.args.get("rpc") or "").strip()
    if override and not ALLOW_RPC_URL_OVERRIDE:
        return jsonify(error="rpc override is disabled; select a network with cluster"), 400
    rpc_url = override or CLUSTER_RPC[cluster]

    try:
        limit = int(request.args.get("limit", DEFAULT_TRANSFER_LIMIT))
    except ValueError:
        return jsonify(error="limit must be an integer"), 400
    if not 1 <= limit <= MAX_TRANSFER_LIMIT:
        return jsonify(error=f"limit must be between 1 and {MAX_TRANSFER_LIMIT}"), 400

    truthy = ("1", "true", "yes")
    refresh = (request.args.get("refresh") or "").lower() in truthy
    # A caller that only wants to know what touched the mint can skip the cost.
    enrich = (request.args.get("enrich") or "true").lower() in truthy

    base = {"mint": mint, "cluster": cluster, "limit": limit, "table": TRANSFERS_TABLE_NAME}

    cached = read_cached_transfers(mint, cluster, limit)

    if not refresh:
        full = len(cached) >= limit
        age, fresh = _chain_check(mint, cluster, limit)

        if cached and (full or fresh):
            # A full page never refetches, so this is the only path able to fill
            # its open rows. No signature lookup is needed, and the window above
            # limits a mint to one budgeted burst however often it is loaded.
            cache_write = None
            if enrich and not fresh:
                open_signatures = {row["signature"] for row in cached if not row.get("kind")}
                if open_signatures:
                    enrich_transfers(cached, mint, rpc_url, ENRICH_BUDGET)
                    # Only a full page gets here, so this vouches for that page.
                    _record_chain_check(mint, cluster, limit, False)
                    now_resolved = [
                        row for row in cached if row["signature"] in open_signatures and row.get("kind")
                    ]
                    if now_resolved:
                        cache_write = _write_transfers(now_resolved)

            return _transfers_response(
                {
                    **base,
                    "source": "s3",
                    "count": len(cached),
                    "newly_cached": 0,
                    "cache_reason": "full" if full else "fresh",
                    "cache_age_seconds": None if age is None else round(age),
                    # Whether a volume total is the whole picture or a floor.
                    "resolved": _resolved_count(cached),
                    "transfers": cached,
                },
                "HIT",
                cache_write,
            )

    unresolved = unresolved_signatures(mint, cluster, limit) if enrich else set()

    try:
        transfers = fetch_transfers(mint, cluster, rpc_url, limit)
    except Exception as exc:  # noqa: BLE001 - an upstream failure, not a bad request
        return jsonify(**base, source="rpc", error="Solana RPC request failed", detail=str(exc)), 502

    # Keep amounts the cache already has, so they are neither lost from this reply
    # nor paid for twice.
    known_rows = {row["signature"]: row for row in cached if row.get("kind")}
    for row in transfers:
        if row["signature"] in known_rows:
            row.update(known_rows[row["signature"]])

    if enrich:
        enrich_transfers(transfers, mint, rpc_url, ENRICH_BUDGET, priority=unresolved)

    known = cached_signatures(mint, cluster)
    to_write = [
        row
        for row in transfers
        if row["signature"] not in known or (row["signature"] in unresolved and row.get("kind"))
    ]
    cache_write = _write_transfers(to_write) if to_write else None

    # If the write failed, the cache doesn't hold what was checked, so it can't
    # answer on the strength of this check.
    if cache_write is not False:
        _record_chain_check(mint, cluster, limit, len(transfers) < limit)

    payload = {
        **base,
        "source": "rpc",
        "count": len(transfers),
        "newly_cached": len(to_write) if cache_write else 0,
        "resolved": _resolved_count(transfers),
        "transfers": transfers,
    }
    if cache_write is False:
        payload["cache_error"] = "cache write failed"

    return _transfers_response(payload, "MISS", cache_write)


@app.post("/insert")
def insert_table():
    # Fail closed: no token configured means writes are off, not open.
    if not API_WRITE_TOKEN:
        return jsonify(error="write endpoint is not configured; set API_WRITE_TOKEN"), 503

    # Bytes, because compare_digest raises TypeError on non-ASCII str, which would
    # turn a bad header into a 500. Constant time, so timing cannot recover a token.
    supplied = request.headers.get("X-API-Token", "").encode()
    if not hmac.compare_digest(supplied, API_WRITE_TOKEN.encode()):
        return jsonify(error="X-API-Token header required"), 401

    if not INSERT_BUCKET:
        return jsonify(error="write endpoint is not configured; set S3_INSERT_BUCKET"), 503

    table_name = request.args.get("table_name")
    if not table_name:
        return jsonify(error="table_name query param is required"), 400

    if not table_name.startswith(INSERT_TABLE_PREFIX):
        return jsonify(error=f"table_name must start with {INSERT_TABLE_PREFIX}"), 400

    # Dots become slashes, so anything else that carries path meaning is rejected
    # rather than normalized.
    if "/" in table_name or "\\" in table_name or ".." in table_name:
        return jsonify(error="table_name must be dotted, e.g. dev.mlh.my_table"), 400

    payload = request.get_json(silent=True)
    # insert_rpc.py posts {"data": [...]}; the bare array form predates it and
    # still works, so both are accepted rather than breaking either caller.
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        return jsonify(error="request body must be a non-empty JSON array of row objects"), 400

    mode = request.args.get("mode", "append")
    if mode not in ("append", "overwrite"):
        return jsonify(error="mode must be 'append' or 'overwrite'"), 400

    timestamp = (request.args.get("timestamp") or "").lower() in ("1", "true", "yes")

    path, written = insert_delta(table_name, rows, timestamp=timestamp, mode=mode)

    return jsonify(table_name=table_name, path=path, mode=mode, rows_written=written), 201


if __name__ == "__main__":
    import os

    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
