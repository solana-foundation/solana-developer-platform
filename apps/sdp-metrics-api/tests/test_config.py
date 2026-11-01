"""AWS credential resolution, which config.py does at import time."""

import importlib

import polars as pl
import pytest

import config

AWS_ENV_VARS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "SOLANA_RPC_URL",
    "LOCALNET_RPC_URL",
)


@pytest.fixture
def load_config(monkeypatch, tmp_path):
    """Reload config under a controlled environment, then restore it."""
    monkeypatch.chdir(tmp_path)  # so load_dotenv cannot pick up a developer's .env
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    for name in AWS_ENV_VARS:
        monkeypatch.delenv(name, raising=False)

    def load(**env):
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        return importlib.reload(config)

    yield load

    monkeypatch.undo()
    importlib.reload(config)


def test_session_token_reaches_storage_options(load_config):
    loaded = load_config(
        AWS_ACCESS_KEY_ID="AKIAEXAMPLE",
        AWS_SECRET_ACCESS_KEY="secret",
        AWS_SESSION_TOKEN="temporary",
    )
    assert loaded.STORAGE_OPTIONS["aws_session_token"] == "temporary"


def test_session_token_is_absent_when_unset(load_config):
    loaded = load_config(AWS_ACCESS_KEY_ID="AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY="secret")
    assert "aws_session_token" not in loaded.STORAGE_OPTIONS


def test_static_keys_need_no_provider(load_config):
    loaded = load_config(AWS_ACCESS_KEY_ID="AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY="secret")
    assert loaded.DELTA_CREDENTIAL_PROVIDER is None


def test_no_keys_and_no_profile_uses_the_standard_chain(load_config):
    """This is what finds an ECS task role."""
    loaded = load_config()
    assert isinstance(loaded.DELTA_CREDENTIAL_PROVIDER, pl.CredentialProviderAWS)


def test_solana_rpc_url_applies_to_the_default_cluster(load_config):
    loaded = load_config(SOLANA_RPC_URL="https://rpc.example.com")
    assert loaded.CLUSTER_RPC[loaded.DEFAULT_CLUSTER] == "https://rpc.example.com"


def test_localnet_does_not_fall_back_to_a_public_cluster(load_config):
    loaded = load_config(SOLANA_RPC_URL="https://rpc.example.com")
    assert loaded.CLUSTER_RPC["localnet"] == "http://127.0.0.1:8899"


def test_cache_reads_and_writes_resolve_to_one_location(load_config):
    loaded = load_config(
        S3_INSERT_BUCKET="bucket", RPC_TABLE_NAME="dev.mlh.counts", S3_RPC_TABLE_PATH="s3://other/place"
    )
    assert loaded.S3_RPC_TABLE_PATH == "s3://bucket/dev/mlh/counts"


def test_transfer_cache_reads_and_writes_resolve_to_one_location(load_config):
    loaded = load_config(
        S3_INSERT_BUCKET="bucket", TRANSFERS_TABLE_NAME="dev.mlh.moves", S3_TRANSFERS_TABLE_PATH="s3://other/place"
    )
    assert loaded.S3_TRANSFERS_TABLE_PATH == "s3://bucket/dev/mlh/moves"
