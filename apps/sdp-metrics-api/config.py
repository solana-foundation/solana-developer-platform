import os

import polars as pl
from dotenv import load_dotenv

# Every path and credential below is resolved at import time, and this module is
# what app.py and the CLI scripts read them through, so .env has to land in
# os.environ before the first env() call rather than in each entry point.
load_dotenv()


def env(name, default=None):
    # A blank `KEY=` line in a sourced .env sets the var to "" rather than
    # leaving it unset, so treat blank the same as unset instead of letting
    # it silently override a working default.
    value = os.environ.get(name)
    return value if value else default


if not os.environ.get("AWS_PROFILE"):
    os.environ.pop("AWS_PROFILE", None)


RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com")
# No default: an unset bucket must not write somewhere unintended.
INSERT_BUCKET = env("S3_INSERT_BUCKET")

# /rpc caches its answers here. The read path is derived from the same dotted
# name insert_delta() writes to, so the cache can never read one location while
# writing another: dev.mlh.rpc_counts -> s3://<bucket>/dev/mlh/rpc_counts.
#
# Deliberately NOT dev.mlh.rpc: that path holds an older per-signature table
# (mint, cluster, signature, slot, block_time, failed, fetched_at). These rows
# are one-per-window aggregates, so appending them there fails on a 5-vs-7 field
# schema mismatch -- which app.py swallows, leaving every call a live RPC read.
RPC_TABLE_NAME = env("RPC_TABLE_NAME", "dev.mlh.rpc_counts")
S3_RPC_TABLE_PATH = f"s3://{INSERT_BUCKET}/{RPC_TABLE_NAME.replace('.', '/')}" if INSERT_BUCKET else None
RPC_CACHE_TTL_SECONDS = int(env("RPC_CACHE_TTL_SECONDS", "3600"))

STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": env("AWS_REGION", "us-east-1"),
        "aws_access_key_id": env("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": env("AWS_SECRET_ACCESS_KEY"),
        # Temporary credentials are rejected as invalid without this.
        "aws_session_token": env("AWS_SESSION_TOKEN"),
    }.items()
    if value
}

# With no static keys and no profile, walk the standard chain. On ECS that is what
# finds the task role; a None provider hands Delta no credentials at all.
DELTA_CREDENTIAL_PROVIDER = None
if not STORAGE_OPTIONS.get("aws_access_key_id"):
    if env("AWS_PROFILE"):
        DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS(profile_name=os.environ["AWS_PROFILE"])
    else:
        try:
            DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS()
        except Exception:
            # Nothing resolvable. Let the S3 call report it, rather than failing
            # at import and taking /healthz down too.
            DELTA_CREDENTIAL_PROVIDER = None

# POST /insert stays disabled until this is set. A missing token is a
# misconfiguration, and serving writes anyway would make it a breach.
API_WRITE_TOKEN = env("API_WRITE_TOKEN")

# table_name maps dots to slashes, so an unconstrained value could address any
# key in the bucket. Every /insert write must fall under this prefix.
INSERT_TABLE_PREFIX = env("INSERT_TABLE_PREFIX", "dev.mlh.")

# ?rpc= makes the server connect to a caller-supplied URL, which reaches internal
# addresses such as the instance metadata service. Off unless explicitly enabled;
# ?cluster= already covers choosing a network.
ALLOW_RPC_URL_OVERRIDE = (env("ALLOW_RPC_URL_OVERRIDE") or "").lower() == "true"

DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DEFAULT_CLUSTER = "devnet"
DEFAULT_DAYS = 30
PAGE_SIZE = 1000

CLUSTER_RPC = {
    # DEFAULT_CLUSTER, so SOLANA_RPC_URL decides where a default request goes.
    "devnet": RPC_URL,
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    "testnet": "https://api.testnet.solana.com",
    # A local validator, for tokens that only exist there.
    "localnet": env("LOCALNET_RPC_URL", "http://127.0.0.1:8899"),
}
