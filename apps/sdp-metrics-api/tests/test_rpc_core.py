"""The counting loops and the cache's freshness rules, without mocking them away.

Only the network is faked. The cache tests read and write real Delta tables on
disk, because the filtering they cover runs inside the Polars scan.
"""

import io
import json
import urllib.error

import polars as pl
import pytest

import app as app_module
import rpc
import rpc_cache
from app import app as flask_app
from rpc import Options, count_recent_transactions, daily_transaction_counts, format_timestamp, solana_rpc

MINT = "So11111111111111111111111111111111111111112"
NOW = 1_756_000_000
DAY = 86_400


def options(days=1, include_failed=False):
    return Options(mint=MINT, cluster="devnet", days=days, rpc_url="http://rpc", include_failed=include_failed)


def signature(name, block_time, err=None):
    return {"signature": name, "blockTime": block_time, "err": err}


@pytest.fixture
def chain(monkeypatch):
    """Serve a newest-first signature list in pages, like getSignaturesForAddress."""
    monkeypatch.setattr(rpc.time, "time", lambda: NOW)
    monkeypatch.setattr(rpc, "PAGE_SIZE", 2)
    calls = []

    def install(entries):
        def fake(_url, method, params):
            assert method == "getSignaturesForAddress"
            calls.append(params[1])
            before = params[1].get("before")
            start = [e["signature"] for e in entries].index(before) + 1 if before else 0
            return entries[start:start + params[1]["limit"]]

        monkeypatch.setattr(rpc, "solana_rpc", fake)
        return calls

    return install


# ---- counting


def test_count_follows_pages_to_the_end(chain):
    calls = chain([signature(f"s{i}", NOW - i) for i in range(5)])
    total, pages, _ = count_recent_transactions(options())
    assert (total, pages) == (5, 3)
    assert calls[1]["before"] == "s1"


def test_count_stops_at_the_cutoff_and_keeps_the_boundary(chain):
    cutoff = NOW - DAY
    chain([signature("new", NOW), signature("edge", cutoff), signature("old", cutoff - 1), signature("older", cutoff - 2)])
    total, _, returned_cutoff = count_recent_transactions(options())
    assert total == 2
    assert returned_cutoff == cutoff


def test_count_skips_failed_transactions_unless_asked(chain):
    chain([signature("ok", NOW), signature("bad", NOW, err={"code": 1})])
    assert count_recent_transactions(options())[0] == 1
    assert count_recent_transactions(options(include_failed=True))[0] == 2


def test_count_of_an_empty_mint_is_zero(chain):
    chain([])
    assert count_recent_transactions(options())[:2] == (0, 0)


def test_series_is_continuous_oldest_first_and_zero_filled(chain):
    chain([signature("today", NOW), signature("three-days", NOW - 2 * DAY)])
    buckets, _, _ = daily_transaction_counts(options(days=3))
    dates = [bucket["date"] for bucket in buckets]
    counts = [bucket["transactionCount"] for bucket in buckets]
    assert dates == sorted(dates)
    assert len(dates) == len(set(dates))
    assert sum(counts) == 2
    assert counts[-1] == 1
    assert 0 in counts


def test_series_cannot_place_a_signature_with_no_time(chain):
    chain([signature("undated", None), signature("dated", NOW)])
    buckets, _, _ = daily_transaction_counts(options())
    assert sum(bucket["transactionCount"] for bucket in buckets) == 1


# ---- malformed RPC replies


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def reply_with(monkeypatch, payload=None, error=None):
    def fake_urlopen(_req, timeout=None):
        if error:
            raise error
        return FakeResponse(payload)

    monkeypatch.setattr(rpc.urllib.request, "urlopen", fake_urlopen)


@pytest.mark.parametrize(
    "payload",
    [b"<html>bad gateway</html>", b"[]", b'"text"', b"{}", b'{"jsonrpc":"2.0"}', b'{"error":"plain text"}', b"\xff\xfe"],
)
def test_malformed_replies_become_runtime_errors(monkeypatch, payload):
    reply_with(monkeypatch, payload)
    with pytest.raises(RuntimeError):
        solana_rpc("http://rpc", "getSlot", [])


def test_rpc_error_message_is_kept(monkeypatch):
    reply_with(monkeypatch, json.dumps({"error": {"message": "rate limited"}}).encode())
    with pytest.raises(RuntimeError, match="rate limited"):
        solana_rpc("http://rpc", "getSlot", [])


@pytest.mark.parametrize("error", [TimeoutError("slow"), urllib.error.URLError("refused")])
def test_transport_failures_become_runtime_errors(monkeypatch, error):
    reply_with(monkeypatch, error=error)
    with pytest.raises(RuntimeError):
        solana_rpc("http://rpc", "getSlot", [])


def test_a_null_result_is_still_a_result(monkeypatch):
    reply_with(monkeypatch, b'{"result":null}')
    assert solana_rpc("http://rpc", "getAccountInfo", []) is None


@pytest.mark.parametrize("path", ["/rpc", "/rpc/series"])
def test_invalid_json_from_the_rpc_answers_502_not_500(monkeypatch, path):
    flask_app.config.update(TESTING=False, PROPAGATE_EXCEPTIONS=False)
    monkeypatch.setattr(app_module, "read_cached", lambda *a, **k: None)
    reply_with(monkeypatch, b"<html>bad gateway</html>")
    assert flask_app.test_client().get(path).status_code == 502


# ---- cache freshness, on a real Delta table


@pytest.fixture
def table(monkeypatch, tmp_path):
    monkeypatch.setattr(rpc_cache, "STORAGE_OPTIONS", {})
    monkeypatch.setattr(rpc_cache, "DELTA_CREDENTIAL_PROVIDER", None)
    path = str(tmp_path / "rpc_counts")

    def write(*rows):
        pl.DataFrame(
            rows,
            schema={"mint": pl.Utf8, "cluster": pl.Utf8, "days": pl.Int64, "transactionCount": pl.Int64, "since": pl.Utf8},
        ).write_delta(path, mode="append")
        return path

    return write


def row(computed_at, count=1, days=1, mint=MINT, cluster="devnet", since=None):
    return {
        "mint": mint,
        "cluster": cluster,
        "days": days,
        "transactionCount": count,
        "since": since if since is not None else format_timestamp(computed_at - days * DAY),
    }


def lookup(path, ttl=3600, days=1, mint=MINT, cluster="devnet"):
    return rpc_cache.read_cached(mint, cluster, days, ttl=ttl, now=NOW, path=path)


def test_a_fresh_row_is_returned_with_only_the_schema_columns(table):
    found = lookup(table(row(NOW - 60, count=5)))
    assert found["transactionCount"] == 5
    assert tuple(found) == rpc_cache.CACHE_COLUMNS


def test_the_newest_fresh_row_wins(table):
    table(row(NOW - 300, count=1))
    table(row(NOW - 60, count=2))
    assert lookup(table(row(NOW - 200, count=3)))["transactionCount"] == 2


@pytest.mark.parametrize("age", [3601, 86_400])
def test_an_expired_row_is_a_miss(table, age):
    assert lookup(table(row(NOW - age))) is None


def test_a_row_exactly_at_the_ttl_is_still_fresh(table):
    assert lookup(table(row(NOW - 3600))) is not None


def test_a_row_from_the_future_is_unusable(table):
    assert lookup(table(row(NOW + 60))) is None


@pytest.mark.parametrize("since", ["not-a-date", ""])
def test_a_row_that_cannot_be_dated_is_skipped(table, since):
    assert lookup(table(row(NOW, since=since))) is None


def test_a_bad_row_does_not_hide_a_good_one(table):
    table(row(NOW, since="not-a-date", count=9))
    assert lookup(table(row(NOW - 60, count=4)))["transactionCount"] == 4


def test_a_row_with_no_count_is_skipped(table):
    assert lookup(table(row(NOW - 60, count=None))) is None


def test_other_mints_clusters_and_windows_do_not_match(table):
    path = table(row(NOW - 60))
    assert lookup(path, mint="other") is None
    assert lookup(path, cluster="testnet") is None
    assert lookup(path, days=7) is None


def test_a_missing_table_is_a_miss(tmp_path, monkeypatch):
    monkeypatch.setattr(rpc_cache, "STORAGE_OPTIONS", {})
    monkeypatch.setattr(rpc_cache, "DELTA_CREDENTIAL_PROVIDER", None)
    assert lookup(str(tmp_path / "absent")) is None
