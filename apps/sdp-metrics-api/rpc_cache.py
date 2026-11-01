

import time
from datetime import datetime, timezone

import polars as pl

from config import (
    DELTA_CREDENTIAL_PROVIDER,
    RPC_CACHE_TTL_SECONDS,
    S3_RPC_TABLE_PATH,
    STORAGE_OPTIONS,
)

TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S.000Z"

CACHE_COLUMNS = ("mint", "cluster", "days", "transactionCount", "since")


def parse_timestamp(value):
   
    return datetime.strptime(value, TIMESTAMP_FORMAT).replace(tzinfo=timezone.utc).timestamp()


def computed_at(record):
    
    return parse_timestamp(record["since"]) + record["days"] * 86400


def read_cached(mint, cluster, days, ttl=None, now=None, path=None):
    """Return the freshest row covering this range, or None for a cache miss.

    Never raises: an absent or unreadable table is reported as a miss so the
    caller falls through to a live RPC read.
    """
    ttl = RPC_CACHE_TTL_SECONDS if ttl is None else ttl
    now = time.time() if now is None else now
    path = S3_RPC_TABLE_PATH if path is None else path
    if not path:
        return None

    try:
        rows = (
            pl.scan_delta(
                path,
                storage_options=STORAGE_OPTIONS,
                credential_provider=DELTA_CREDENTIAL_PROVIDER,
            )
            .filter(
                (pl.col("mint") == mint)
                & (pl.col("cluster") == cluster)
                & (pl.col("days") == days)
            )
            .collect()
            .to_dicts()
        )
    except Exception:
        return None

    fresh = []
    for row in rows:
        # A row written by anything other than /rpc may not carry the columns
        # freshness is derived from; skip it rather than guess.
        if any(row.get(column) is None for column in CACHE_COLUMNS):
            continue
        try:
            age = now - computed_at(row)
        except (ValueError, TypeError):
            continue
        # Negative age means the row claims to be from the future -- a clock
        # skew or a hand-written row. Treat it as unusable, not as fresh.
        if 0 <= age <= ttl:
            fresh.append((age, row))

    if not fresh:
        return None

    _, newest = min(fresh, key=lambda pair: pair[0])
    return {column: newest[column] for column in CACHE_COLUMNS}
