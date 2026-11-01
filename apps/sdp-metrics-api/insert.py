"""POST /insert support — write JSON payloads as Delta tables to S3."""

from datetime import datetime, timezone

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, INSERT_BUCKET, STORAGE_OPTIONS


def delta_path(table_name):
    return f"s3://{INSERT_BUCKET}/{table_name.replace('.', '/')}"


def insert_delta(
    table_name, records, timestamp=False, mode="append", evolve_schema=False, schema_overrides=None
):
    """Build a DataFrame from records and append it as a Delta table on S3.

    table_name uses dots (Databricks catalog.schema.table style); S3 uses
    slashes, so dev.mlh.my_table -> s3://<bucket>/dev/mlh/my_table.

    timestamp=True adds an ingested_at column; default False writes the payload
    columns exactly as given so appends match the existing table schema.

    mode="append" creates the table on first write and appends after; the only
    other value Delta accepts here is "overwrite", which replaces it wholesale.

    schema_overrides pins named column types instead of inferring them, for a
    column that can be entirely null in a valid payload.

    evolve_schema=True lets an append add columns the table lacks. It is off by
    default because schema enforcement is what stops a typo in a field name from
    widening a table Databricks reads.
    """
    if not INSERT_BUCKET:
        raise RuntimeError("S3_INSERT_BUCKET is not set")

    df = pl.DataFrame(records, schema_overrides=schema_overrides)

    if timestamp and "ingested_at" not in df.columns:
        df = df.with_columns(pl.lit(datetime.now(timezone.utc)).alias("ingested_at"))

    path = delta_path(table_name)
    df.write_delta(
        path,
        mode=mode,
        storage_options=STORAGE_OPTIONS,
        credential_provider=DELTA_CREDENTIAL_PROVIDER,
        delta_write_options={"schema_mode": "merge"} if evolve_schema else None,
    )

    return path, len(df)
