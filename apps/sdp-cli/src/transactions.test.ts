import assert from "node:assert/strict";
import test from "node:test";
import {
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  type UnifiedTransaction,
} from "@sdp/types/unified-transactions";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_history", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "history-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "history-key", SDP_API_URL: session.SDP_API_URL };
const transaction = {
  id: "payments:xfr_example",
  module: "payments",
  moduleId: "xfr_example",
  kind: "pay",
  status: "pending",
  moduleStatus: "processing",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  custodyWalletId: "cwlt_example",
  custodyWalletLabel: "Treasury",
  token: SOL_MINT,
  amount: "9007199254740993.000000001",
  counterpartyId: null,
  signature: null,
  createdAt: meta.timestamp,
} satisfies UnifiedTransaction;
const mixedRows = [
  transaction,
  {
    ...transaction,
    id: "earn:movement_example",
    module: "earn",
    moduleId: "movement_example",
    kind: "withdraw",
    moduleStatus: "requested",
    amount: null,
    custodyWalletLabel: null,
  },
  {
    ...transaction,
    id: "dvp:trade_example",
    module: "dvp",
    moduleId: "trade_example",
    kind: "fund",
    moduleStatus: "funded",
    projectId: null,
    custodyWalletId: null,
    custodyWalletLabel: null,
    token: null,
    amount: null,
  },
  {
    ...transaction,
    id: "private_channels:transfer_example",
    module: "private_channels",
    moduleId: "transfer_example",
    kind: "transfer",
    moduleStatus: "settled",
    status: "succeeded",
    amount: "0",
    counterpartyId: "cpty_example",
  },
  {
    ...transaction,
    id: "issuance:mint_example",
    module: "issuance",
    moduleId: "mint_example",
    kind: "mint",
    moduleStatus: "failed",
    status: "failed",
    signature: "signature_fixture",
  },
  {
    ...transaction,
    id: "rings:operation_example",
    module: "rings",
    moduleId: "operation_example",
    kind: "withdraw",
    moduleStatus: "voided",
    status: "canceled",
    createdAt: "2026-10-28T01:02:03Z",
  },
] satisfies UnifiedTransaction[];
const cursor = "opaque+/=:%?#& λ";
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  response: Response,
  options: { env?: NodeJS.ProcessEnv; failure?: Error } = {}
) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? apiKey,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      if (options.failure) throw options.failure;
      return response;
    },
    readStdin: async () => {
      throw new Error("History reads cannot consume stdin");
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}
function emptyResponse() {
  return Response.json({ data: { transactions: [], nextCursor: null }, meta });
}
function apiError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message }, meta }, { status });
}

test("transaction history help is available without authentication and describes cursor filters", async () => {
  for (const args of [
    ["transactions"],
    ["transactions", "--help"],
    ["transactions", "list", "--help"],
  ]) {
    const result = await invoke(args, emptyResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("sdp transactions list"));
    if (args.includes("list")) {
      for (const flag of [
        "module",
        "kind",
        "status",
        "custody-wallet-id",
        "counterparty-id",
        "asset",
        "search",
        "from",
        "to",
        "cursor",
        "limit",
      ])
        assert(result.stdout.includes(`--${flag}`));
      assert(result.stdout.includes("transactions.read"));
      assert(result.stdout.includes("prefix"));
      assert(!result.stdout.includes("--page"));
      assert(!result.stdout.includes("--idempotency-key"));
    }
  }
});

test("history authorization and session project requirements come from the generated contract", () => {
  const operation = operationById("listUnifiedTransactions");
  assert.deepEqual(operation.authorization, { kind: "action", action: "transactions.read" });
  assert.equal(operation.method, "GET");
  assert.equal(operation.path, "/v1/transactions");
  assert.equal(operation.sessionOnly, false);
  assert.equal(operation.body, null);
  assert(operation.parameters.some((parameter) => parameter.name === "x-project-id"));
  assert(
    !operation.parameters.some((parameter) => parameter.name.toLowerCase() === "idempotency-key")
  );
});

test("a default history read makes one bodyless API-key request without inventing pagination or metadata", async () => {
  for (const envelope of [
    { data: { transactions: [], nextCursor: null } },
    { data: { transactions: [], nextCursor: null }, meta },
  ]) {
    const result = await invoke(["transactions", "list"], Response.json(envelope));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(result.requests.length, 1);
    const request = result.requests[0];
    assert.equal(request.url, "http://localhost:8787/v1/transactions");
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.body, undefined);
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("authorization"), "Bearer history-key");
    assert.equal(headers.get("x-project-id"), null);
    assert.equal(headers.get("content-type"), null);
  }
});

test("session history reads require a project and allow an explicit project override", async () => {
  const missing = await invoke(["transactions", "list"], emptyResponse(), {
    env: { SDP_TOKEN: session.SDP_TOKEN },
  });
  assert.equal(missing.code, 2, missing.stderr);
  assert.equal(missing.requests.length, 0);
  assert(missing.stderr.includes("--project"));
  for (const args of [
    ["transactions", "list"],
    ["transactions", "list", "--project", "prj_override"],
  ]) {
    const result = await invoke(args, emptyResponse(), { env: session });
    assert.equal(result.code, 0, result.stderr);
    const headers = new Headers(result.requests[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer history-session");
    assert.equal(
      headers.get("x-project-id"),
      args.includes("--project") ? "prj_override" : session.SDP_PROJECT_ID
    );
    assert.equal(new URL(result.requests[0].url).search, "");
  }
});

test("all history filters map to the API query without leaking tenant or transfer selectors", async () => {
  const result = await invoke(
    [
      "transactions",
      "list",
      "--module",
      "payments",
      "--kind",
      "onramp",
      "--status",
      "pending",
      "--custody-wallet-id",
      "cwlt_+/?",
      "--counterparty-id",
      "cpty_example",
      "--asset",
      SOL_MINT,
      "--search",
      "xfr_%+&",
      "--from",
      "2026-10-01T00:00:00Z",
      "--to",
      "2026-10-29T00:00:00.000Z",
      "--cursor",
      cursor,
      "--limit",
      "100",
      "--organization",
      "org_example",
    ],
    emptyResponse(),
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const url = new URL(result.requests[0].url);
  assert.equal(url.pathname, "/v1/transactions");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    module: "payments",
    kind: "onramp",
    status: "pending",
    custodyWalletId: "cwlt_+/?",
    counterpartyId: "cpty_example",
    token: SOL_MINT,
    search: "xfr_%+&",
    createdAtFrom: "2026-10-01T00:00:00Z",
    createdAtTo: "2026-10-29T00:00:00.000Z",
    cursor,
    limit: "100",
  });
});

test("mixed history preserves every runtime module, nullable field, exact amount and row order", async () => {
  assert.deepEqual(
    [...new Set(mixedRows.map((row) => row.module))].sort(),
    [...UNIFIED_TRANSACTION_MODULES].sort()
  );
  const envelope = {
    data: { transactions: mixedRows, nextCursor: cursor },
    meta,
    extension: { source: "fixture" },
  };
  const result = await invoke(["transactions", "list", "--compact"], Response.json(envelope));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout), envelope);
  assert.equal(result.stdout, `${JSON.stringify(envelope)}\n`);
});

test("each runtime module and its kind can be selected, including publication-held history", async () => {
  for (const row of mixedRows) {
    const result = await invoke(
      ["transactions", "list", "--module", row.module, "--kind", row.kind],
      Response.json({ data: { transactions: [row], nextCursor: null }, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data.transactions, [row]);
    assert.equal(new URL(result.requests[0].url).searchParams.get("module"), row.module);
    assert.equal(new URL(result.requests[0].url).searchParams.get("kind"), row.kind);
    assert.equal(result.requests.length, 1);
  }
});

test("all normalized history statuses are accepted without changing their wire values", async () => {
  for (const status of UNIFIED_TRANSACTION_STATUSES) {
    const result = await invoke(["transactions", "list", "--status", status], emptyResponse());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).searchParams.get("status"), status);
  }
});

test("pagination forwards opaque cursors only on explicit calls and preserves the server default", async () => {
  const first = await invoke(
    ["transactions", "list", "--limit", "1"],
    Response.json({ data: { transactions: [transaction], nextCursor: cursor }, meta })
  );
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.requests.length, 1);
  assert.equal(new URL(first.requests[0].url).searchParams.get("cursor"), null);
  const nextCursor: string = JSON.parse(first.stdout).data.nextCursor;
  const second = await invoke(
    ["transactions", "list", "--limit", "1", "--cursor", nextCursor],
    emptyResponse()
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.requests.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(second.requests[0].url).searchParams), {
    cursor,
    limit: "1",
  });
  assert.equal(JSON.parse(second.stdout).data.nextCursor, null);
  const explicitEmpty = await invoke(["transactions", "list", "--cursor="], emptyResponse());
  assert.equal(explicitEmpty.code, 0, explicitEmpty.stderr);
  assert.equal(new URL(explicitEmpty.requests[0].url).searchParams.get("cursor"), "");
});

test("history rejects invalid enum, bounded, timestamp and numeric query values locally", async () => {
  for (const flags of [
    ["--module", "unknown"],
    ["--status", "completed"],
    ["--status", "pending,succeeded"],
    ["--search", "ab"],
    ["--search", "x".repeat(201)],
    ["--custody-wallet-id", "x".repeat(129)],
    ["--counterparty-id", "x".repeat(129)],
    ["--asset", "x".repeat(129)],
    ["--from", "yesterday"],
    ["--to", "2026-02-30T00:00:00Z"],
    ...["0", "101", "1.5", "NaN", "Infinity", "-1"].map((value) => [`--limit=${value}`]),
  ]) {
    const result = await invoke(["transactions", "list", ...flags], emptyResponse());
    assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0);
    assert.equal(result.stdout, "");
  }
});

test("module-kind relations and cursor validity remain server-owned validation", async () => {
  for (const flags of [
    ["--kind", "pay"],
    ["--module", "payments", "--kind", "mint"],
    ["--cursor", "malformed"],
  ]) {
    const result = await invoke(
      ["transactions", "list", ...flags],
      apiError(400, "BAD_REQUEST", "Invalid history filters or cursor.")
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.status, 400);
    assert.equal(result.stdout, "");
  }
});

test("history permission, release-channel and quota failures stay visible without retrying", async () => {
  for (const [status, code, message] of [
    [401, "UNAUTHORIZED", "Credential expired."],
    [403, "INSUFFICIENT_PERMISSIONS", "Missing action: onramp.read"],
    [403, "MODULE_UNAVAILABLE", "Requested module is unavailable in this release channel."],
    [429, "RATE_LIMITED", "Transaction history quota exceeded."],
    [500, "INTERNAL_ERROR", "History unavailable."],
    [503, "SERVICE_UNAVAILABLE", "Quota backend unavailable."],
  ] as const) {
    const result = await invoke(
      ["transactions", "list", "--module", "payments", "--kind", "onramp"],
      apiError(status, code, message)
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code,
      message,
      status,
      requestId: meta.requestId,
    });
    assert.equal(result.requests.length, 1);
  }
  const network = await invoke(["transactions", "list"], emptyResponse(), {
    failure: new TypeError("connection lost"),
  });
  assert.equal(network.code, 1);
  assert.equal(network.requests.length, 1);
  assert.equal(JSON.parse(network.stderr).error.code, "NETWORK_ERROR");
});

test("malformed history rows or pagination never produce partial output", async () => {
  for (const data of [
    { transactions: [transaction] },
    { transactions: [], nextCursor: 0 },
    { transactions: [{ ...transaction, amount: 10 }], nextCursor: null },
    { transactions: [{ ...transaction, custodyWalletLabel: 42 }], nextCursor: null },
    { transactions: [{ ...transaction, module: "unknown" }], nextCursor: null },
    { transactions: [{ ...transaction, kind: "mint" }], nextCursor: null },
    { transactions: [{ ...transaction, moduleStatus: "settled" }], nextCursor: null },
    { transactions: [{ ...transaction, status: "completed" }], nextCursor: null },
  ]) {
    const result = await invoke(["transactions", "list"], Response.json({ data, meta }));
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert.equal(result.requests.length, 1);
  }
});

test("history refuses bodies, page pagination, mutation flags and nonexistent detail commands", async () => {
  for (const args of [
    ["transactions", "list", "--data", "{}"],
    ["transactions", "list", "--page", "1"],
    ["transactions", "list", "--page-size", "50"],
    ["transactions", "list", "--idempotency-key", "not-supported"],
    ["transactions", "list", "--wallet-id", "provider_wallet"],
    ["transactions", "list", "--provider", "moonpay"],
    ["transactions", "list", "--sort-by", "amount"],
    ["transactions", "list", "--all"],
    ["transactions", "get", transaction.id],
    ["transactions", "list", transaction.id],
  ]) {
    const result = await invoke(args, emptyResponse());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
