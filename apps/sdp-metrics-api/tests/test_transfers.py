"""GET /rpc/transfers, against a real Delta table on disk and a fake RPC.

The cache's behaviour is mostly about how real Delta writes and reads combine:
schema evolution, all-null columns, and duplicates from append-only backfill.
Mocking those away would test nothing, so only the network and S3 are replaced.
"""

import polars as pl
import pytest

import app as app_module
import insert as insert_module
import transfer_cache
import transfers as transfers_module
from app import app as flask_app
from transfers import classify, token_deltas

MINT = "So11111111111111111111111111111111111111112"
OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
URL = f"/rpc/transfers?mint={MINT}"


def balance(owner, raw, mint=MINT, decimals=6):
    return {"mint": mint, "owner": owner, "uiTokenAmount": {"amount": str(raw), "decimals": decimals}}


def transfer_meta(amount=1_500_000):
    return {
        "preTokenBalances": [balance("alice", 5_000_000), balance("bob", 0)],
        "postTokenBalances": [balance("alice", 5_000_000 - amount), balance("bob", amount)],
    }


class FakeChain:
    def __init__(self):
        self.signatures = []
        self.metas = {}
        self.signature_calls = 0
        self.resolved_calls = []
        self.fail_batch = False

    def add(self, signature, block_time, meta=None):
        self.signatures.insert(0, {"signature": signature, "slot": block_time, "blockTime": block_time, "err": None})
        self.metas[signature] = transfer_meta() if meta is None else meta

    def rpc(self, _url, method, params):
        assert method == "getSignaturesForAddress"
        self.signature_calls += 1
        before = params[1].get("before")
        start = 0
        if before:
            start = [row["signature"] for row in self.signatures].index(before) + 1
        return self.signatures[start:start + params[1]["limit"]]

    def batch(self, _url, calls):
        if self.fail_batch:
            raise RuntimeError("rate limited")
        out = []
        for call in calls:
            signature = call["params"][0]
            self.resolved_calls.append(signature)
            out.append({"id": call["id"], "result": {"meta": self.metas[signature]}})
        return out


@pytest.fixture
def chain(monkeypatch, tmp_path):
    fake = FakeChain()
    table = str(tmp_path / "transfers")

    monkeypatch.setattr(transfers_module, "solana_rpc", fake.rpc)
    monkeypatch.setattr(transfers_module, "solana_rpc_batch", fake.batch)
    monkeypatch.setattr(insert_module, "delta_path", lambda name: table)
    monkeypatch.setattr(insert_module, "STORAGE_OPTIONS", {})
    monkeypatch.setattr(insert_module, "DELTA_CREDENTIAL_PROVIDER", None)
    monkeypatch.setattr(insert_module, "INSERT_BUCKET", "test-bucket")
    monkeypatch.setattr(transfer_cache, "S3_TRANSFERS_TABLE_PATH", table)
    monkeypatch.setattr(transfer_cache, "STORAGE_OPTIONS", {})
    monkeypatch.setattr(transfer_cache, "DELTA_CREDENTIAL_PROVIDER", None)
    monkeypatch.setattr(app_module, "ENRICH_BUDGET", 25)
    app_module._last_chain_check.clear()
    fake.table = table
    return fake


@pytest.fixture
def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


def stored_rows(chain):
    return pl.read_delta(chain.table).height


def forget_chain_check():
    app_module._last_chain_check.clear()


# ---- classification


def test_a_transfer_nets_to_zero_and_counts_each_token_once():
    deltas, decimals = token_deltas(transfer_meta(1_500_000), MINT)
    assert classify(deltas, decimals) == {
        "amount": "1.5",
        "source": "alice",
        "destination": "bob",
        "kind": "transfer",
    }


def test_a_mint_nets_positive():
    meta = {"preTokenBalances": [], "postTokenBalances": [balance("treasury", 1_000_000)]}
    result = classify(*token_deltas(meta, MINT))
    assert (result["kind"], result["amount"], result["source"], result["destination"]) == (
        "mint", "1", None, "treasury",
    )


def test_a_burn_nets_negative():
    meta = {"preTokenBalances": [balance("holder", 2_000_000)], "postTokenBalances": [balance("holder", 500_000)]}
    result = classify(*token_deltas(meta, MINT))
    assert (result["kind"], result["amount"], result["source"]) == ("burn", "1.5", "holder")


def test_other_mints_in_the_transaction_are_ignored():
    meta = {
        "preTokenBalances": [balance("alice", 900, mint=OTHER_MINT)],
        "postTokenBalances": [balance("alice", 100, mint=OTHER_MINT)],
    }
    assert classify(*token_deltas(meta, MINT))["kind"] == "no_movement"


def test_base_units_keep_a_large_balance_exact():
    pre = 998_102_430_035_874
    meta = {"preTokenBalances": [balance("a", pre), balance("b", 0)],
            "postTokenBalances": [balance("a", pre - 1), balance("b", 1)]}
    assert classify(*token_deltas(meta, MINT))["amount"] == "0.000001"


def test_zero_decimals_does_not_divide():
    meta = {"preTokenBalances": [], "postTokenBalances": [balance("nft", 1, decimals=0)]}
    assert classify(*token_deltas(meta, MINT))["amount"] == "1"


# ---- input


@pytest.mark.parametrize(
    "query",
    [
        "",
        "mint=",
        "mint=not-base58!",
        "mint=short",
        f"mint={MINT}&cluster=bogus",
        f"mint={MINT}&limit=abc",
        f"mint={MINT}&limit=0",
        f"mint={MINT}&limit=1001",
        f"mint={MINT}&rpc=http://169.254.169.254/",
    ],
)
def test_bad_input_is_rejected_before_any_rpc(client, chain, query):
    assert client.get(f"/rpc/transfers?{query}").status_code == 400
    assert chain.signature_calls == 0


def test_token_address_is_an_alias_for_mint(client, chain):
    chain.add("sig1", 100)
    body = client.get(f"/rpc/transfers?token_address={MINT}").get_json()
    assert body["mint"] == MINT
    assert body["count"] == 1


# ---- cache flow


def test_first_call_misses_then_a_quiet_token_gets_a_hit(client, chain):
    chain.add("sig1", 100)

    first = client.get(URL)
    assert first.headers["X-Cache"] == "MISS"
    assert first.headers["X-Cache-Write"] == "ok"
    assert first.get_json()["transfers"][0]["amount"] == "1.5"
    assert first.get_json()["newly_cached"] == 1

    second = client.get(URL)
    body = second.get_json()
    assert second.headers["X-Cache"] == "HIT"
    assert "X-Cache-Write" not in second.headers
    assert (body["source"], body["cache_reason"], body["count"]) == ("s3", "fresh", 1)
    assert chain.signature_calls == 1


def test_a_full_page_hits_without_a_recent_chain_check(client, chain):
    chain.add("sig1", 100)
    client.get(f"{URL}&limit=1")
    forget_chain_check()
    calls = chain.signature_calls

    resp = client.get(f"{URL}&limit=1")
    assert resp.headers["X-Cache"] == "HIT"
    assert resp.get_json()["cache_reason"] == "full"
    assert chain.signature_calls == calls


def test_a_token_with_only_its_creation_can_be_cached(client, chain):
    """Every amount column is null here, which Delta refuses unless typed."""
    chain.add("create", 100, meta={"preTokenBalances": [], "postTokenBalances": []})

    first = client.get(URL)
    assert first.headers["X-Cache-Write"] == "ok"
    assert first.get_json()["transfers"][0]["kind"] == "no_movement"
    assert client.get(URL).headers["X-Cache"] == "HIT"


def test_only_missing_signatures_are_written(client, chain):
    chain.add("sig1", 100)
    client.get(URL)
    forget_chain_check()
    chain.add("sig2", 200)

    body = client.get(URL).get_json()
    assert body["newly_cached"] == 1
    assert stored_rows(chain) == 2

    forget_chain_check()
    second = client.get(URL)
    assert second.get_json()["newly_cached"] == 0
    assert "X-Cache-Write" not in second.headers
    assert stored_rows(chain) == 2


def test_backfill_converges_without_an_unbounded_write_loop(client, chain, monkeypatch):
    monkeypatch.setattr(app_module, "ENRICH_BUDGET", 1)
    for index in range(3):
        chain.add(f"sig{index}", 100 + index)

    assert client.get(URL).get_json()["resolved"] == 1

    forget_chain_check()
    assert client.get(URL).get_json()["resolved"] == 2

    forget_chain_check()
    third = client.get(URL).get_json()
    assert third["resolved"] == 3
    assert third["count"] == 3
    assert len({row["signature"] for row in third["transfers"]}) == 3
    assert stored_rows(chain) == 5  # 3 originals plus 2 backfills

    # Nothing is left open, so further requests write nothing and resolve nothing.
    resolved_before = len(chain.resolved_calls)
    forget_chain_check()
    fourth = client.get(URL)
    assert fourth.get_json()["newly_cached"] == 0
    assert stored_rows(chain) == 5
    assert len(chain.resolved_calls) == resolved_before


def test_a_full_page_fills_its_open_rows_on_a_hit(client, chain, monkeypatch):
    monkeypatch.setattr(app_module, "ENRICH_BUDGET", 1)
    chain.add("sig0", 100)
    chain.add("sig1", 101)
    assert client.get(f"{URL}&limit=2").get_json()["resolved"] == 1

    forget_chain_check()
    calls = chain.signature_calls
    resp = client.get(f"{URL}&limit=2")
    assert resp.headers["X-Cache"] == "HIT"
    assert resp.headers["X-Cache-Write"] == "ok"
    assert resp.get_json()["resolved"] == 2
    assert chain.signature_calls == calls

    forget_chain_check()
    assert client.get(f"{URL}&limit=2").get_json()["resolved"] == 2
    assert stored_rows(chain) == 3


def test_a_resolved_row_beats_a_newer_unresolved_one(chain):
    """Recency alone would pick the row with no amount here."""
    base = {"mint": MINT, "cluster": "devnet", "signature": "sig0", "slot": 1, "block_time": 100, "failed": False}
    insert_module.insert_delta(
        "t",
        [{**base, "fetched_at": "2026-01-01T00:00:00", "amount": "1.5", "decimals": 6,
          "source": "a", "destination": "b", "kind": "transfer"}],
        schema_overrides=transfer_cache.TRANSFER_TABLE_SCHEMA,
    )
    insert_module.insert_delta(
        "t",
        [{**base, "fetched_at": "2026-01-02T00:00:00", "amount": None, "decimals": None,
          "source": None, "destination": None, "kind": None}],
        schema_overrides=transfer_cache.TRANSFER_TABLE_SCHEMA,
    )

    rows = transfer_cache.read_cached_transfers(MINT, "devnet", 10)
    assert [(row["signature"], row["amount"]) for row in rows] == [("sig0", "1.5")]


def test_a_refetch_keeps_amounts_it_does_not_pay_for_again(client, chain):
    chain.add("sig0", 100)
    client.get(URL)
    assert chain.resolved_calls == ["sig0"]
    forget_chain_check()

    body = client.get(f"{URL}&refresh=true").get_json()
    assert body["source"] == "rpc"
    assert body["transfers"][0]["amount"] == "1.5"
    assert chain.resolved_calls == ["sig0"]


def test_a_table_written_before_enrichment_gains_the_new_columns(client, chain):
    chain.add("old", 100)
    client.get(f"{URL}&enrich=false")
    assert "kind" not in pl.read_delta(chain.table).columns

    forget_chain_check()
    chain.add("new", 200)
    body = client.get(URL).get_json()
    assert "kind" in pl.read_delta(chain.table).columns
    assert body["count"] == 2
    assert body["resolved"] == 2


def test_mints_and_clusters_do_not_share_rows(client, chain):
    chain.add("sig0", 100)
    client.get(URL)
    forget_chain_check()
    assert transfer_cache.read_cached_transfers(OTHER_MINT, "devnet", 10) == []
    assert transfer_cache.read_cached_transfers(MINT, "testnet", 10) == []


def test_enrich_false_makes_no_transaction_calls(client, chain):
    chain.add("sig0", 100)
    body = client.get(f"{URL}&enrich=false").get_json()
    assert body["transfers"][0]["signature"] == "sig0"
    assert chain.resolved_calls == []
    assert body["resolved"] == 0


# ---- failure


def test_a_rejected_batch_still_returns_the_signatures(client, chain):
    chain.add("sig0", 100)
    chain.fail_batch = True
    resp = client.get(URL)
    body = resp.get_json()
    assert resp.status_code == 200
    assert body["count"] == 1
    assert body["resolved"] == 0
    assert body["transfers"][0]["kind"] is None


def test_a_failed_cache_write_returns_data_and_hides_the_cause(client, chain, monkeypatch):
    chain.add("sig0", 100)

    def fail(*a, **k):
        raise RuntimeError("AccessDenied on s3://private-bucket/secret/path")

    monkeypatch.setattr(app_module, "insert_delta", fail)
    resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.headers["X-Cache-Write"] == "failed"
    body = resp.get_json()
    assert body["count"] == 1
    assert body["newly_cached"] == 0
    assert body["cache_error"] == "cache write failed"
    assert "private-bucket" not in resp.get_data(as_text=True)


def test_an_rpc_failure_is_502_and_echoes_the_request(client, chain, monkeypatch):
    def fail(*a, **k):
        raise RuntimeError("RPC HTTP 429")

    monkeypatch.setattr(transfers_module, "solana_rpc", fail)
    resp = client.get(URL)
    assert resp.status_code == 502
    assert resp.get_json()["mint"] == MINT


def test_without_a_bucket_it_still_answers_live(client, chain, monkeypatch):
    chain.add("sig0", 100)
    monkeypatch.setattr(transfer_cache, "S3_TRANSFERS_TABLE_PATH", None)
    monkeypatch.setattr(insert_module, "INSERT_BUCKET", None)
    resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.headers["X-Cache"] == "MISS"
    assert resp.headers["X-Cache-Write"] == "failed"
    assert resp.get_json()["count"] == 1


def test_tracked_mints_are_bounded(chain, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_TRACKED_MINTS", 2)
    for mint in ("a", "b", "c"):
        app_module._record_chain_check(mint, "devnet", 1, False)
    assert list(app_module._last_chain_check) == [("b", "devnet"), ("c", "devnet")]


def test_counts_on_rpc_are_unchanged_by_this_route():
    """/rpc's body is the rpc_counts schema, and must not grow transfer fields."""
    assert app_module.RPC_SCHEMA == ("mint", "cluster", "days", "transactionCount", "since")


# ---- review findings


def test_a_small_page_does_not_answer_a_larger_one(client, chain):
    for index in range(3):
        chain.add(f"sig{index}", 100 + index)

    assert client.get(f"{URL}&limit=1").get_json()["count"] == 1

    larger = client.get(f"{URL}&limit=100")
    assert larger.headers["X-Cache"] == "MISS"
    assert larger.get_json()["count"] == 3


def test_a_check_that_reached_the_end_answers_a_larger_page(client, chain):
    chain.add("only", 100)
    client.get(f"{URL}&limit=10")
    calls = chain.signature_calls

    larger = client.get(f"{URL}&limit=1000")
    assert larger.headers["X-Cache"] == "HIT"
    assert larger.get_json()["cache_reason"] == "fresh"
    assert chain.signature_calls == calls


def test_a_failed_write_is_not_treated_as_a_check(client, chain, monkeypatch):
    chain.add("sig0", 100)
    client.get(URL)
    forget_chain_check()
    chain.add("sig1", 200)

    def fail(*a, **k):
        raise RuntimeError("denied")

    monkeypatch.setattr(app_module, "insert_delta", fail)
    assert client.get(URL).get_json()["count"] == 2

    # The cache still holds only sig0, so it must not answer as though it were current.
    again = client.get(URL)
    assert again.headers["X-Cache"] == "MISS"
    assert again.get_json()["count"] == 2


def test_amounts_first_cached_without_enrichment_are_saved(client, chain):
    chain.add("sig0", 100)
    client.get(f"{URL}&enrich=false")
    forget_chain_check()

    first = client.get(URL)
    assert first.get_json()["transfers"][0]["amount"] == "1.5"
    assert chain.resolved_calls == ["sig0"]

    forget_chain_check()
    second = client.get(URL)
    assert second.get_json()["transfers"][0]["amount"] == "1.5"
    assert chain.resolved_calls == ["sig0"]
    assert second.get_json()["newly_cached"] == 0


def test_a_transaction_with_no_metadata_stays_open_and_is_retried(client, chain):
    chain.add("sig0", 100)
    original = chain.batch

    def no_meta(_url, calls):
        return [{"id": call["id"], "result": {"meta": None}} for call in calls]

    transfers_module.solana_rpc_batch = no_meta
    try:
        body = client.get(URL).get_json()
    finally:
        transfers_module.solana_rpc_batch = original

    assert body["resolved"] == 0
    assert body["transfers"][0]["kind"] is None

    forget_chain_check()
    retried = client.get(URL).get_json()
    assert retried["resolved"] == 1
    assert retried["transfers"][0]["kind"] == "transfer"


def test_an_amount_beyond_float_precision_is_exact(client, chain):
    huge = 18_446_744_073_709_551_615  # u64 max
    meta = {
        "preTokenBalances": [balance("a", huge), balance("b", 0)],
        "postTokenBalances": [balance("a", 0), balance("b", huge)],
    }
    chain.add("sig0", 100, meta=meta)

    assert client.get(URL).get_json()["transfers"][0]["amount"] == "18446744073709.551615"
    assert client.get(URL).get_json()["source"] == "s3"
    assert client.get(URL).get_json()["transfers"][0]["amount"] == "18446744073709.551615"


@pytest.mark.parametrize(
    ("base_units", "decimals", "expected"),
    [(0, 6, "0"), (1, 6, "0.000001"), (1_500_000, 6, "1.5"), (2_000_000, 6, "2"), (7, 0, "7"), (7, None, "7")],
)
def test_format_amount(base_units, decimals, expected):
    assert transfers_module.format_amount(base_units, decimals) == expected
