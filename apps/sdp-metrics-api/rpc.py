import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from config import PAGE_SIZE


@dataclass
class Options:
    mint: str
    cluster: str
    days: int
    rpc_url: str
    include_failed: bool


def solana_rpc(rpc_url, method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RPC HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"RPC request failed: {exc.reason}") from exc

    if body.get("error"):
        message = body["error"].get("message", "Unknown RPC error")
        raise RuntimeError(message)

    return body["result"]


def count_recent_transactions(options):
    cutoff = int(time.time()) - options.days * 24 * 60 * 60
    before = None
    total = 0
    pages = 0

    while True:
        query = {"limit": PAGE_SIZE}
        if before:
            query["before"] = before

        signatures = solana_rpc(
            options.rpc_url,
            "getSignaturesForAddress",
            [options.mint, query],
        )

        if not signatures:
            break

        pages += 1

        for entry in signatures:
            block_time = entry.get("blockTime")
            if block_time is not None and block_time < cutoff:
                return total, pages, cutoff

            if not options.include_failed and entry.get("err") is not None:
                continue

            total += 1

        before = signatures[-1]["signature"]

        if len(signatures) < PAGE_SIZE:
            break

    return total, pages, cutoff


def daily_transaction_counts(options):
    """Transactions per UTC day over the lookback window, oldest day first.

    Walks the same signature pages as count_recent_transactions, but keeps the
    per-day tally instead of a single total. Days with no activity are emitted
    as zero so the series is continuous and a chart cannot imply a gap is a
    dip in the axis rather than a real quiet day.

    Returns (buckets, pages, cutoff) where buckets is a list of
    {"date": "YYYY-MM-DD", "transactionCount": int}.
    """
    cutoff = int(time.time()) - options.days * 24 * 60 * 60
    counts = {}
    before = None
    pages = 0
    done = False

    while not done:
        query = {"limit": PAGE_SIZE}
        if before:
            query["before"] = before

        signatures = solana_rpc(
            options.rpc_url,
            "getSignaturesForAddress",
            [options.mint, query],
        )

        if not signatures:
            break

        pages += 1

        for entry in signatures:
            block_time = entry.get("blockTime")
            if block_time is not None and block_time < cutoff:
                done = True
                break

            if not options.include_failed and entry.get("err") is not None:
                continue

            # A signature with no blockTime cannot be placed on a day axis.
            # Counting it under "today" would invent activity, so skip it —
            # /rpc's total remains the authority on the window's true count.
            if block_time is None:
                continue

            day = datetime.fromtimestamp(block_time, tz=timezone.utc).strftime("%Y-%m-%d")
            counts[day] = counts.get(day, 0) + 1

        if done:
            break

        before = signatures[-1]["signature"]

        if len(signatures) < PAGE_SIZE:
            break

    # Zero-fill every day in the window, oldest first.
    start = datetime.fromtimestamp(cutoff, tz=timezone.utc).date()
    end = datetime.now(tz=timezone.utc).date()
    buckets = []
    day = start
    while day <= end:
        key = day.strftime("%Y-%m-%d")
        buckets.append({"date": key, "transactionCount": counts.get(key, 0)})
        day += timedelta(days=1)

    return buckets, pages, cutoff


def format_timestamp(unix_seconds):
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
