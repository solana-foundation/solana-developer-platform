import pytest

import app as app_module
from app import app as flask_app


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_insert_is_off_without_a_bucket(client, monkeypatch):
    def explode(*a, **k):
        raise AssertionError("no write may happen without a configured bucket")

    monkeypatch.setattr(app_module, "API_WRITE_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "INSERT_BUCKET", None)
    monkeypatch.setattr(app_module, "insert_delta", explode)
    resp = client.post(
        "/insert?table_name=dev.mlh.scratch",
        json={"data": [{"id": 1}]},
        headers={"X-API-Token": "test-token"},
    )
    assert resp.status_code == 503


def test_cache_read_is_a_miss_without_a_table_path(monkeypatch):
    import rpc_cache

    monkeypatch.setattr(rpc_cache, "S3_RPC_TABLE_PATH", None)
    assert rpc_cache.read_cached("mint", "devnet", 1) is None
