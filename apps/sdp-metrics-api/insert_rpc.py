#!/usr/bin/env python3
"""Create the dev.mlh.rpc_counts table by feeding /rpc's response to POST /insert.

The Delta table's schema is exactly the /rpc response shape, so the record is
passed through verbatim -- no renaming, no added columns:

    mint              str    the SPL mint that was queried
    cluster           str    devnet | mainnet-beta | testnet
    days              i64    lookback window
    transactionCount  i64    signatures counted in that window
    since             str    cutoff as %Y-%m-%dT%H:%M:%S.000Z

insert_delta() writes with mode="append", which creates the table on the first
run and appends on every run after, so this doubles as the table's bootstrap.

The `timestamp` flag on /insert is deliberately left off: it would add an
ingested_at column and the table would no longer match the /rpc response.

By default the app is driven in-process via Flask's test client, so no server
needs to be running. Pass --base-url to go over HTTP against a live instance.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Dots are the Databricks catalog.schema.table style that insert_delta() maps
# onto S3 -- dev.mlh.rpc_counts becomes s3://<bucket>/dev/mlh/rpc_counts.
# Must stay in step with config.RPC_TABLE_NAME: this script bootstraps the very
# table /rpc's cache reads back.
TABLE_NAME = "dev.mlh.rpc_counts"

# The columns /rpc returns. Compared as a set -- jsonify sorts keys
# alphabetically, and Delta matches an append by column name, not position.
RPC_SCHEMA = ("mint", "cluster", "days", "transactionCount", "since")


class InProcessTransport:
    """Drive the Flask app directly, without a running server."""

    def __init__(self):
        from app import app

        self.client = app.test_client()

    def get(self, path):
        response = self.client.get(path)
        return response.status_code, response.get_json()

    def post(self, path, payload):
        response = self.client.post(path, json=payload, headers={"X-API-Token": os.environ.get("API_WRITE_TOKEN", "")})
        return response.status_code, response.get_json()


class HttpTransport:
    """Talk to an already-running server over HTTP."""

    def __init__(self, base_url, timeout):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get(self, path):
        return self._send("GET", path, None)

    def post(self, path, payload):
        return self._send("POST", path, payload)

    def _send(self, method, path, payload):
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=(
                {"Content-Type": "application/json", "X-API-Token": os.environ.get("API_WRITE_TOKEN", "")}
                if data
                else {}
            ),
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as exc:
            # The API reports its own failures as JSON bodies on 4xx/5xx, so
            # surface those rather than letting the exception escape.
            return exc.code, _decode(exc.read())
        except urllib.error.URLError as exc:
            raise SystemExit(f"cannot reach {self.base_url}: {exc.reason}")


def _decode(raw):
    text = raw.decode()
    try:
        return json.loads(text)
    except ValueError:
        return text


def build_rpc_path(args):
    query = {"days": args.days}
    if args.mint:
        query["mint"] = args.mint
    if args.cluster:
        query["cluster"] = args.cluster
    if args.rpc:
        query["rpc"] = args.rpc

    return "/rpc?" + urllib.parse.urlencode(query)


def check_schema(record):
    """Fail loudly if /rpc's shape drifts away from the table's."""
    actual = tuple(record)
    if actual == RPC_SCHEMA:
        return

    missing = [field for field in RPC_SCHEMA if field not in actual]
    extra = [field for field in actual if field not in RPC_SCHEMA]
    if missing or extra:
        raise SystemExit(
            "/rpc response no longer matches the table schema "
            f"(missing: {missing or 'none'}, unexpected: {extra or 'none'}). "
            "Writing it would corrupt the rpc_counts table -- aborting."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=1, help="lookback window passed to /rpc (default: 1)")
    parser.add_argument("--mint", help="SPL mint to query (default: the app's DEFAULT_MINT)")
    parser.add_argument("--cluster", help="devnet | mainnet-beta | testnet (default: the app's DEFAULT_CLUSTER)")
    parser.add_argument("--rpc", help="override the Solana RPC URL /rpc calls (needs ALLOW_RPC_URL_OVERRIDE=true on the server)")
    parser.add_argument("--table-name", default=TABLE_NAME, help=f"insert target (default: {TABLE_NAME})")
    parser.add_argument("--base-url", help="hit a running server instead of the in-process test client")
    parser.add_argument("--timeout", type=float, default=180.0, help="HTTP timeout in seconds (default: 180)")
    parser.add_argument("--dry-run", action="store_true", help="fetch /rpc and print the payload without inserting")
    args = parser.parse_args()

    transport = HttpTransport(args.base_url, args.timeout) if args.base_url else InProcessTransport()

    rpc_path = build_rpc_path(args)
    print(f"GET {rpc_path}")
    status, record = transport.get(rpc_path)
    if status != 200 or not isinstance(record, dict):
        print(f"/rpc failed with {status}: {record}", file=sys.stderr)
        return 1

    check_schema(record)
    print(f"  {json.dumps(record)}")

    payload = {"data": [record]}
    insert_path = "/insert?" + urllib.parse.urlencode({"table_name": args.table_name})

    if args.dry_run:
        print(f"\n[dry run] would POST {insert_path}")
        print(f"  {json.dumps(payload)}")
        return 0

    print(f"\nPOST {insert_path}")
    status, body = transport.post(insert_path, payload)
    print(f"  status: {status}")
    print(f"  body: {json.dumps(body) if isinstance(body, (dict, list)) else body}")

    if status != 201:
        return 1

    print(f"\nWrote {body['rows_written']} row to {body['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
