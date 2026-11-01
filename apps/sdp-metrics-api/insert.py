"""POST /insert support — write JSON payloads as Delta tables to S3."""

from datetime import datetime, timezone

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, INSERT_BUCKET, STORAGE_OPTIONS


def insert_delta(table_name, records, timestamp=False, mode="append"):
    """Build a DataFrame from records and append it as a Delta table on S3.

    table_name uses dots (Databricks catalog.schema.table style); S3 uses
    slashes, so dev.mlh.my_table -> s3://<bucket>/dev/mlh/my_table.

    timestamp=True adds an ingested_at column; default False writes the payload
    columns exactly as given so appends match the existing table schema.

    mode="append" creates the table on first write and appends after; the only
    other value Delta accepts here is "overwrite", which replaces it wholesale.
    """
    if not INSERT_BUCKET:
        raise RuntimeError("S3_INSERT_BUCKET is not set")

    df = pl.DataFrame(records)

    if timestamp and "ingested_at" not in df.columns:
        df = df.with_columns(pl.lit(datetime.now(timezone.utc)).alias("ingested_at"))

    path = f"s3://{INSERT_BUCKET}/{table_name.replace('.', '/')}"
    df.write_delta(
        path,
        mode=mode,
        storage_options=STORAGE_OPTIONS,
        credential_provider=DELTA_CREDENTIAL_PROVIDER,
    )

    return path, len(df)
