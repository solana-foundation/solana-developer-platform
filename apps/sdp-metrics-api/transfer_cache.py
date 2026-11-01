"""Read side of the transfer cache, a Delta table with one row per transaction.

Writes go through insert_delta(), the same function POST /insert uses. The table
is append-only, so a signature can appear twice: once unresolved, and again with
its amount. Reads collapse those to the better answer.

Every read here treats a missing or unreadable table as empty, because the
caller's next move is the same either way: go to the RPC.
"""

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, S3_TRANSFERS_TABLE_PATH, STORAGE_OPTIONS

# Polars infers an all-None column as Null, which Delta refuses to write. A token
# whose only transaction is its own creation has no amount at all, so the types
# are declared rather than inferred from the rows in hand.
TRANSFER_TABLE_SCHEMA = {
    "mint": pl.Utf8,
    "cluster": pl.Utf8,
    "signature": pl.Utf8,
    "slot": pl.Int64,
    "block_time": pl.Int64,
    "failed": pl.Boolean,
    "fetched_at": pl.Utf8,
    # A decimal string: a float can't hold every amount a u64 token balance allows.
    "amount": pl.Utf8,
    "decimals": pl.Int64,
    "source": pl.Utf8,
    "destination": pl.Utf8,
    "kind": pl.Utf8,
}


def _scan(mint, cluster):
    frame = pl.scan_delta(
        S3_TRANSFERS_TABLE_PATH,
        storage_options=STORAGE_OPTIONS,
        credential_provider=DELTA_CREDENTIAL_PROVIDER,
    )
    return frame.filter((pl.col("mint") == mint) & (pl.col("cluster") == cluster))


def read_cached_transfers(mint, cluster, limit):
    """Up to `limit` cached rows for a mint, newest first, one per signature."""
    if not S3_TRANSFERS_TABLE_PATH:
        return []

    try:
        frame = _scan(mint, cluster)

        # `kind` only exists once enrichment has written to the table, and
        # reading an absent column is an error rather than a null.
        if "kind" in frame.collect_schema().names():
            # Resolved rows sort ahead of unresolved ones for the same signature,
            # so keep="first" picks the row with the amount.
            frame = frame.sort(
                ["block_time", "kind", "fetched_at"],
                descending=[True, True, True],
                nulls_last=True,
            )
        else:
            frame = frame.sort("block_time", descending=True, nulls_last=True)

        rows = (
            frame.unique(subset=["signature"], keep="first", maintain_order=True)
            .limit(limit)
            .collect()
        )
    except Exception:
        return []

    return rows.to_dicts()


def unresolved_signatures(mint, cluster, limit):
    """Signatures with no amount in any of their rows.

    Backfill appends rather than updates, so a resolved signature still has its
    original null row. Asking only "which signatures have a null row" would keep
    returning it, and every request would append another copy.

    A table with no `kind` column was only ever written without amounts, so all of
    its signatures are open.
    """
    if not S3_TRANSFERS_TABLE_PATH:
        return set()

    try:
        frame = _scan(mint, cluster)
        if "kind" not in frame.collect_schema().names():
            rows = frame.select("signature").unique().limit(limit).collect()
            return set(rows["signature"].to_list())

        rows = (
            frame.group_by("signature")
            .agg(pl.col("kind").is_not_null().any().alias("resolved"))
            .filter(~pl.col("resolved"))
            .select("signature")
            .limit(limit)
            .collect()
        )
    except Exception:
        return set()

    return set(rows["signature"].to_list())


def cached_signatures(mint, cluster):
    """Every signature cached for a mint.

    A Delta append does not deduplicate, so only signatures missing from this set
    are written. Otherwise the table grows on every request without gaining rows.
    """
    if not S3_TRANSFERS_TABLE_PATH:
        return set()

    try:
        rows = _scan(mint, cluster).select("signature").collect()
    except Exception:
        return set()

    return set(rows["signature"].to_list())
