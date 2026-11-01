"""Contract tests for GET /rpc.

The response body IS the dev.mlh.rpc_counts Delta schema — insert_rpc.py appends
it verbatim — so a drift in these keys silently corrupts the table. Everything
that would touch S3 or the network is patched out.
"""

import pytest

import app as app_module
from app import RPC_SCHEMA, app as flask_app


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


@pytest.fixture
def offline(monkeypatch):
    """No RPC, no cache read, no Delta write."""
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: None)
    monkeypatch.setattr(app_module, "insert_delta", lambda *a, **k: ("s3://test/table", 1))
    monkeypatch.setattr(
        app_module, "count_recent_transactions", lambda options: (42, 1, 1_756_000_000)
    )


def test_rpc_body_is_exactly_the_table_schema(client, offline):
    body = client.get("/rpc?days=1").get_json()
    assert set(body) == set(RPC_SCHEMA)


def test_rpc_reports_the_count_and_echoes_the_query(client, offline):
    body = client.get("/rpc?days=7&cluster=testnet&mint=SoMeMint111").get_json()
    assert body["transactionCount"] == 42
    assert body["days"] == 7
    assert body["cluster"] == "testnet"
    assert body["mint"] == "SoMeMint111"


def test_cache_hit_short_circuits_the_rpc_call(client, monkeypatch):
    cached = {
        "mint": "M",
        "cluster": "devnet",
        "days": 1,
        "transactionCount": 7,
        "since": "2026-09-01T00:00:00.000Z",
    }
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: cached)

    def explode(options):
        raise AssertionError("a cache hit must not reach the RPC")

    monkeypatch.setattr(app_module, "count_recent_transactions", explode)

    response = client.get("/rpc?days=1&mint=M")
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "HIT"
    assert response.get_json() == cached


def test_refresh_bypasses_the_cache(client, offline, monkeypatch):
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: {"never": "used"})
    response = client.get("/rpc?days=1&refresh=true")
    assert response.headers["X-Cache"] == "MISS"
    assert response.get_json()["transactionCount"] == 42


def test_include_failed_is_never_cached(client, offline, monkeypatch):
    """It changes the count but is not a column, so it must not be written."""
    writes = []
    monkeypatch.setattr(
        app_module, "insert_delta", lambda *a, **k: writes.append(a) or ("s3://t", 1)
    )
    client.get("/rpc?days=1&include_failed=true")
    assert writes == []


def test_a_failed_cache_write_still_answers(client, offline, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("no credentials")

    monkeypatch.setattr(app_module, "insert_delta", boom)
    response = client.get("/rpc?days=1")
    assert response.status_code == 200
    assert response.get_json()["transactionCount"] == 42


def test_upstream_rpc_failure_is_502_not_400(client, monkeypatch):
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: None)

    def boom(options):
        raise RuntimeError("RPC HTTP 429")

    monkeypatch.setattr(app_module, "count_recent_transactions", boom)
    response = client.get("/rpc?days=1")
    assert response.status_code == 502


@pytest.mark.parametrize(
    "query",
    ["cluster=bogus", "days=abc", "days=0", "days=366", "days=-5", "mint=%20"],
)
def test_bad_input_is_rejected_before_any_rpc(client, monkeypatch, query):
    def explode(options):
        raise AssertionError("invalid input must not reach the RPC")

    monkeypatch.setattr(app_module, "count_recent_transactions", explode)
    assert client.get(f"/rpc?{query}").status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# GET /rpc/series — the chart's data source. Not a Delta table, so it is free to
# carry fields /rpc cannot; it must still agree with /rpc on the total.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def offline_series(monkeypatch):
    """Three transactions across two days inside a 3-day window."""
    import time as _time

    now = int(_time.time())
    day = 24 * 60 * 60
    buckets = [
        {"date": "2026-09-01", "transactionCount": 2},
        {"date": "2026-09-02", "transactionCount": 0},
        {"date": "2026-09-03", "transactionCount": 1},
    ]
    monkeypatch.setattr(
        app_module, "daily_transaction_counts", lambda options: (buckets, 1, now - 3 * day)
    )


def test_series_returns_a_continuous_bucket_list(client, offline_series):
    body = client.get("/rpc/series?days=3").get_json()
    assert [b["date"] for b in body["series"]] == ["2026-09-01", "2026-09-02", "2026-09-03"]
    assert [b["transactionCount"] for b in body["series"]] == [2, 0, 1]


def test_series_echoes_the_query_and_window(client, offline_series):
    body = client.get("/rpc/series?days=3&cluster=testnet&mint=SoMeMint111").get_json()
    assert body["mint"] == "SoMeMint111"
    assert body["cluster"] == "testnet"
    assert body["days"] == 3
    assert body["since"].endswith("Z")


def test_series_is_not_written_to_the_delta_cache(client, offline_series, monkeypatch):
    """Its shape is not the rpc_counts schema, so it must never be appended."""
    writes = []
    monkeypatch.setattr(
        app_module, "insert_delta", lambda *a, **k: writes.append(a) or ("s3://t", 1)
    )
    client.get("/rpc/series?days=3")
    assert writes == []


def test_series_upstream_failure_is_502(client, monkeypatch):
    def boom(options):
        raise RuntimeError("RPC HTTP 429")

    monkeypatch.setattr(app_module, "daily_transaction_counts", boom)
    assert client.get("/rpc/series?days=3").status_code == 502


@pytest.mark.parametrize("query", ["cluster=bogus", "days=abc", "days=0", "days=366"])
def test_series_rejects_bad_input_before_any_rpc(client, monkeypatch, query):
    def explode(options):
        raise AssertionError("invalid input must not reach the RPC")

    monkeypatch.setattr(app_module, "daily_transaction_counts", explode)
    assert client.get(f"/rpc/series?{query}").status_code == 400


def test_rpc_override_is_refused_by_default(client, monkeypatch):
    def explode(options):
        raise AssertionError("a refused override must not reach the RPC")

    monkeypatch.setattr(app_module, "count_recent_transactions", explode)
    resp = client.get("/rpc?rpc=http://169.254.169.254/latest/meta-data/")
    assert resp.status_code == 400


def test_rpc_override_works_when_enabled(client, offline, monkeypatch):
    seen = {}

    def capture(options):
        seen["rpc_url"] = options.rpc_url
        return (1, 1, 1_756_000_000)

    monkeypatch.setattr(app_module, "ALLOW_RPC_URL_OVERRIDE", True)
    monkeypatch.setattr(app_module, "count_recent_transactions", capture)
    assert client.get("/rpc?rpc=http://localhost:8899").status_code == 200
    assert seen["rpc_url"] == "http://localhost:8899"


@pytest.fixture
def write_token(monkeypatch):
    monkeypatch.setattr(app_module, "API_WRITE_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "INSERT_BUCKET", "test-bucket")
    monkeypatch.setattr(app_module, "insert_delta", lambda *a, **k: ("s3://test/table", 1))


ROWS = {"data": [{"id": 1}]}
GOOD_TABLE = "/insert?table_name=dev.mlh.scratch"


def test_insert_is_off_without_a_configured_token(client, monkeypatch):
    def explode(*a, **k):
        raise AssertionError("no write may happen without a configured token")

    monkeypatch.setattr(app_module, "API_WRITE_TOKEN", None)
    monkeypatch.setattr(app_module, "insert_delta", explode)
    resp = client.post(GOOD_TABLE, json=ROWS, headers={"X-API-Token": "anything"})
    assert resp.status_code == 503


@pytest.mark.parametrize("headers", [{}, {"X-API-Token": "wrong"}, {"X-API-Token": "caf\xc3\xa9"}])
def test_insert_rejects_a_bad_token(client, write_token, headers):
    assert client.post(GOOD_TABLE, json=ROWS, headers=headers).status_code == 401


@pytest.mark.parametrize(
    "name", ["prod.secrets", "dev.mlh/../other", "dev.mlh..other", "dev.mlh.a/b", "dev.mlh.a\\b"]
)
def test_insert_confines_the_table_name(client, write_token, name):
    resp = client.post(
        "/insert", query_string={"table_name": name}, json=ROWS, headers={"X-API-Token": "test-token"}
    )
    assert resp.status_code == 400


def test_insert_accepts_a_valid_token_and_table(client, write_token):
    resp = client.post(GOOD_TABLE, json=ROWS, headers={"X-API-Token": "test-token"})
    assert resp.status_code == 201


def test_rpc_override_never_touches_the_cache(client, monkeypatch):
    def explode(*a, **k):
        raise AssertionError("an override must not read or write the shared cache")

    monkeypatch.setattr(app_module, "ALLOW_RPC_URL_OVERRIDE", True)
    monkeypatch.setattr(app_module, "read_cached", explode)
    monkeypatch.setattr(app_module, "insert_delta", explode)
    monkeypatch.setattr(app_module, "count_recent_transactions", lambda options: (7, 1, 1_756_000_000))

    resp = client.get("/rpc?rpc=http://localhost:8899")
    assert resp.status_code == 200
    assert resp.headers["X-Cache"] == "MISS"
    assert resp.get_json()["transactionCount"] == 7
