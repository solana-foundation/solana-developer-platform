

import time
import polars as pl

from config import (
    DELTA_CREDENTIAL_PROVIDER,
    RPC_CACHE_TTL_SECONDS,
    S3_RPC_TABLE_PATH,
    STORAGE_OPTIONS,
)

TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S.000Z"

CACHE_COLUMNS = ("mint", "cluster", "days", "transactionCount", "since")


def read_cached(mint, cluster, days, ttl=None, now=None, path=None):
    """Return the freshest row covering this range, or None for a cache miss.

    Never raises: an absent or unreadable table is reported as a miss so the
    caller falls through to a live RPC read.

    A row's age comes from its columns: `since` is the window's start, so adding
    `days` gives when it was computed. Rows that can't be dated, or claim to be
    from the future (clock skew, or written by hand), are unusable rather than
    fresh. All of this runs before collect(), because the table only grows.
    """
    ttl = RPC_CACHE_TTL_SECONDS if ttl is None else ttl
    now = time.time() if now is None else now
    path = S3_RPC_TABLE_PATH if path is None else path
    if not path:
        return None

    computed_at = (
        pl.col("since").str.to_datetime(TIMESTAMP_FORMAT, strict=False, time_unit="us").dt.epoch("s")
        + pl.col("days") * 86400
    )
    age = now - computed_at

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
                & pl.col("transactionCount").is_not_null()
                & age.is_between(0, ttl)
            )
            .sort(computed_at, descending=True)
            .limit(1)
            .select(CACHE_COLUMNS)
            .collect()
            .to_dicts()
        )
    except Exception:
        return None

    return rows[0] if rows else None
