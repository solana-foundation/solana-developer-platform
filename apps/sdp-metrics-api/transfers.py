"""Recent transfers for a mint, read from the chain.

getSignaturesForAddress says a transaction touched the mint. It does not say how
much moved or between whom. Those live in the transaction, under
meta.preTokenBalances and meta.postTokenBalances, so resolving an amount costs
one getTransaction per signature. That cost is why enrichment is budgeted.
"""

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone

from config import PAGE_SIZE
from rpc import solana_rpc


def fetch_transfers(mint, cluster, rpc_url, limit):
    """Return the most recent successful transactions for a mint, newest first."""
    rows = []
    before = None

    while len(rows) < limit:
        query = {"limit": min(PAGE_SIZE, limit - len(rows))}
        if before:
            query["before"] = before

        signatures = solana_rpc(rpc_url, "getSignaturesForAddress", [mint, query])
        if not signatures:
            break

        for entry in signatures:
            if entry.get("err") is not None:
                continue

            rows.append({
                "mint": mint,
                "cluster": cluster,
                "signature": entry["signature"],
                "slot": entry.get("slot"),
                "block_time": entry.get("blockTime"),
                "failed": False,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            })

            if len(rows) >= limit:
                break

        before = signatures[-1]["signature"]

        if len(signatures) < query["limit"]:
            break

    return rows


def token_deltas(meta, mint):
    """Per-owner balance change for one mint, in raw base units.

    Returns (deltas, decimals). Base units rather than ui amounts because ui
    amounts are floats: subtracting two of them for a large balance leaves noise
    in the low decimal places. The integers are exact, so the division happens
    once, at the end.
    """
    before = {}
    after = {}
    decimals = None

    for entries, sink in (
        (meta.get("preTokenBalances") or [], before),
        (meta.get("postTokenBalances") or [], after),
    ):
        for entry in entries:
            if entry.get("mint") != mint:
                continue
            owner = entry.get("owner")
            if owner is None:
                continue
            amount = entry.get("uiTokenAmount") or {}
            if decimals is None:
                decimals = amount.get("decimals")
            raw = amount.get("amount")
            if raw is None:
                continue
            try:
                sink[owner] = sink.get(owner, 0) + int(raw)
            except (TypeError, ValueError):
                continue

    deltas = {}
    for owner in set(before) | set(after):
        change = after.get(owner, 0) - before.get(owner, 0)
        if change != 0:
            deltas[owner] = change

    return deltas, decimals


def classify(deltas, decimals):
    """Turn per-owner deltas into an amount, counterparties and a kind.

    The sum across owners is the tell: a transfer nets to zero, a mint nets
    positive and a burn nets negative. A signature can touch the mint without
    moving any of it, which is recorded as no_movement rather than left open.
    """
    if not deltas:
        return {"amount": None, "source": None, "destination": None, "kind": "no_movement"}

    gained = {owner: delta for owner, delta in deltas.items() if delta > 0}
    lost = {owner: delta for owner, delta in deltas.items() if delta < 0}
    net = sum(deltas.values())

    if net > 0:
        kind = "mint"
    elif net < 0:
        kind = "burn"
    else:
        kind = "transfer"

    # What moved, not the sum of every account's change: a transfer counts each
    # token once, on the receiving side.
    moved = sum(gained.values()) if gained else abs(sum(lost.values()))
    scale = 10 ** decimals if decimals else 1

    return {
        "amount": moved / scale,
        "source": min(lost, key=lost.get) if lost else None,
        "destination": max(gained, key=gained.get) if gained else None,
        "kind": kind,
    }


def enrich_transfers(rows, mint, rpc_url, budget, chunk_size=10, priority=None):
    """Resolve as many open rows as the budget allows. Mutates and returns rows.

    A row with kind None is open: "not resolved yet", which is a different fact
    from no_movement. Only open rows spend budget, and `priority` signatures go
    first, so coverage climbs across requests instead of stalling.

    A failure here never fails the request. The signatures are already a correct
    answer to what touched this mint.
    """
    for row in rows:
        for column in ("amount", "decimals", "source", "destination", "kind"):
            row.setdefault(column, None)

    candidates = [row for row in rows if row.get("signature") and row["kind"] is None]
    if priority:
        candidates.sort(key=lambda row: row["signature"] not in priority)

    pending = candidates[:budget]

    for start in range(0, len(pending), chunk_size):
        window = pending[start:start + chunk_size]
        batch = [
            {
                "jsonrpc": "2.0",
                "id": index,
                "method": "getTransaction",
                "params": [
                    row["signature"],
                    {"maxSupportedTransactionVersion": 0, "encoding": "jsonParsed"},
                ],
            }
            for index, row in enumerate(window)
        ]

        try:
            responses = solana_rpc_batch(rpc_url, batch)
        except Exception:
            # Rate limited, or the endpoint refused the batch. Stop rather than
            # retry into a harder limit; a later request fills what is left.
            break

        by_id = {response.get("id"): response for response in responses if isinstance(response, dict)}
        for index, row in enumerate(window):
            result = (by_id.get(index) or {}).get("result")
            if not result:
                continue
            deltas, decimals = token_deltas(result.get("meta") or {}, mint)
            row.update(classify(deltas, decimals))
            row["decimals"] = decimals

    return rows


def solana_rpc_batch(rpc_url, batch):
    """Send an array of JSON-RPC calls in one HTTP request.

    Separate from solana_rpc because one call in the array can fail while the
    rest succeed, so there is no single result to unwrap or error to raise.
    """
    req = urllib.request.Request(
        rpc_url,
        data=json.dumps(batch).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RPC HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"RPC request failed: {exc.reason}") from exc

    if isinstance(body, dict):
        # Some endpoints answer a batch with a single error object.
        raise RuntimeError(body.get("error", {}).get("message", "RPC batch rejected"))

    return body
