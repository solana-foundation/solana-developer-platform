import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DVP_CLOSE_REFUSAL,
  DVP_LEG_REFUSAL,
  DVP_SETTLEMENT_AVAILABILITY,
  DVP_TRADE_STATUSES,
} from "@sdp/types/dvp";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { type JsonObject, operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_dvp", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "dvp-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "dvp-key", SDP_API_URL: session.SDP_API_URL };
const key = "trade-intent-42";
const amount = "18446744073709551615";
const terms = {
  partyA: { walletId: "cwlt_a" },
  partyB: { counterpartyAccountId: "cpa_b" },
  mintA: SOL_MINT,
  mintB: SOL_MINT,
  tokenProgramA: SPL_TOKEN_PROGRAMS["spl-token"],
  tokenProgramB: SPL_TOKEN_PROGRAMS["token-2022"],
  amountA: amount,
  amountB: "9007199254740993",
  expiryTimestamp: "9223372036854775807",
};
const leg = {
  party: { address: SOL_MINT, counterparty: null, wallet: { id: "cwlt_a", name: null } },
  mint: SOL_MINT,
  name: null,
  imageUrl: null,
  tokenProgram: terms.tokenProgramA,
  amount,
  escrow: SOL_MINT,
  settlementDestination: SOL_MINT,
  funding: null,
  fundingSignature: null,
  outcome: "awaiting",
  transfers: [],
  decimals: null,
  symbol: null,
};
const trade = {
  id: "dvp_example",
  status: "creating",
  swapDvp: SOL_MINT,
  settlementAuthority: SOL_MINT,
  legs: { a: leg, b: { ...leg, tokenProgram: terms.tokenProgramB } },
  kind: "principal",
  nonce: "9007199254740993",
  expiryTimestamp: terms.expiryTimestamp,
  earliestSettlementTimestamp: null,
  settlementAvailability: null,
  refString: null,
  createSignature: "signature_fixture",
  observedAt: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const inboundLeg = {
  party: { address: SOL_MINT, counterparty: null, wallet: null },
  mint: SOL_MINT,
  tokenProgram: terms.tokenProgramA,
  amount,
  decimals: null,
  symbol: null,
  name: null,
  imageUrl: null,
  escrow: SOL_MINT,
  settlementDestination: SOL_MINT,
  observedAmount: null,
  frozen: null,
  outcome: "awaiting",
  transfers: [],
};
const inbound = {
  id: trade.id,
  status: "created",
  swapDvp: SOL_MINT,
  settlementAuthority: SOL_MINT,
  yourSide: "b",
  yourParty: SOL_MINT,
  legs: { a: inboundLeg, b: inboundLeg },
  expiryTimestamp: terms.expiryTimestamp,
  earliestSettlementTimestamp: null,
  settlementAvailability: null,
  createdAt: meta.timestamp,
  observedAt: null,
};
const createArgs = [
  "dvp",
  "trades",
  "create",
  "--party-a",
  JSON.stringify(terms.partyA),
  "--party-b",
  JSON.stringify(terms.partyB),
  "--mint-a",
  terms.mintA,
  "--mint-b",
  terms.mintB,
  "--token-program-a",
  terms.tokenProgramA,
  "--token-program-b",
  terms.tokenProgramB,
  "--amount-a",
  terms.amountA,
  "--amount-b",
  terms.amountB,
  "--expiry-timestamp",
  terms.expiryTimestamp,
];
const commands = [
  ["dvp", "mints", "inspect", SOL_MINT],
  [...createArgs],
  ["dvp", "trades", "list"],
  ["dvp", "trades", "inbound", "list"],
  ["dvp", "trades", "get", trade.id],
  ["dvp", "trades", "fund", trade.id, "--side", "a"],
  ["dvp", "trades", "reclaim", trade.id, "--side", "b"],
  ["dvp", "trades", "settle", trade.id],
  ["dvp", "trades", "cancel", trade.id],
];
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  response: Response,
  options: { env?: NodeJS.ProcessEnv; stdin?: string; failure?: Error } = {}
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
    readStdin: async () => options.stdin ?? "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}
function response(data: JsonObject, status = 200) {
  return Response.json({ data, meta }, { status });
}
function error(status = 403, code = "FORBIDDEN", message = "DvP unavailable") {
  return Response.json({ error: { code, message }, meta }, { status });
}
function body(record: RecordedRequest) {
  return JSON.parse(String(record.init.body));
}

test("all nine DvP operations have offline help and the action registry's grants", async () => {
  for (const args of [
    ["dvp"],
    ["dvp", "trades"],
    ["dvp", "mints"],
    ...commands.map((args) => [...args, "--help"]),
  ]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  for (const [id, action] of [
    ["inspectDvpMint", "dvp.read"],
    ["createDvpTrade", "dvp.manage"],
    ["listDvpTrades", "dvp.read"],
    ["listInboundDvpTrades", "dvp.read"],
    ["getDvpTrade", "dvp.read"],
    ["fundDvpTrade", "dvp.execute"],
    ["reclaimDvpTrade", "dvp.manage"],
    ["settleDvpTrade", "dvp.execute"],
    ["cancelDvpTrade", "dvp.manage"],
  ]) {
    assert.deepEqual(operationById(id).authorization, { kind: "action", action });
    assert.equal(operationById(id).sessionOnly, false);
  }
});

test("every DvP session operation requires a project before making a request", async () => {
  for (const args of commands) {
    const result = await invoke(args, error(), { env: { SDP_TOKEN: session.SDP_TOKEN } });
    assert.equal(result.code, 2, result.stderr);
    assert(result.stderr.includes("--project"));
    assert.equal(result.requests.length, 0);
  }
});

test("mint inspection preserves unknown precision and explicit ineligibility without making another lookup", async () => {
  const mint = {
    mint: SOL_MINT,
    tokenProgram: terms.tokenProgramB,
    decimals: null,
    name: null,
    symbol: null,
    eligible: false,
    blockedBy: "unreadable extension data",
  };
  const result = await invoke(["dvp", "mints", "inspect", SOL_MINT], response({ mint }), {
    env: session,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, { mint });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, `http://localhost:8787/v1/dvp/mints/${SOL_MINT}`);
  assert.equal(
    new Headers(result.requests[0].init.headers).get("x-project-id"),
    session.SDP_PROJECT_ID
  );
});

test("mint not-found and RPC failures stay distinct from eligibility results", async () => {
  for (const [status, code] of [
    [404, "NOT_FOUND"],
    [502, "SOLANA_RPC_ERROR"],
  ] as const) {
    const result = await invoke(["dvp", "mints", "inspect", "bad/address?"], error(status, code));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, code);
    assert.equal(result.requests.length, 1);
    assert.equal(new URL(result.requests[0].url).pathname, "/v1/dvp/mints/bad%2Faddress%3F");
  }
});

test("creation sends base units, token programs and exact 64-bit strings without conversions", async () => {
  const result = await invoke([...createArgs, "--idempotency-key", key], response({ trade }, 201), {
    env: session,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), terms);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].init.method, "POST");
  assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), key);
  assert.deepEqual(JSON.parse(result.stdout), { data: { trade }, meta });
});

test("create supports JSON, files and stdin with explicit nulls and settlement destinations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-dvp-terms-"));
  try {
    const payload = {
      ...terms,
      partyA: { address: SOL_MINT },
      earliestSettlementTimestamp: null,
      userASettlementDestination: SOL_MINT,
      userBSettlementDestination: null,
      refString: "00042",
    };
    const input = JSON.stringify(payload),
      filename = path.join(directory, "trade.json");
    await writeFile(filename, input);
    for (const source of [input, `@${filename}`, "-"]) {
      const result = await invoke(
        ["dvp", "trades", "create", "--data", source, "--idempotency-key", key],
        response({ trade }, 201),
        { stdin: input }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), payload);
      assert.equal(result.requests.length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional create terms retain signed timestamp strings and empty references without synthesizing a nonce", async () => {
  const result = await invoke(
    [
      ...createArgs,
      "--earliest-settlement-timestamp=-9223372036854775808",
      "--user-a-settlement-destination",
      SOL_MINT,
      "--ref-string",
      "",
    ],
    response({ trade }, 201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    ...terms,
    earliestSettlementTimestamp: "-9223372036854775808",
    userASettlementDestination: SOL_MINT,
    refString: "",
  });
  assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
});

test("lists send server-side filters as one request and preserve null observations", async () => {
  const statuses = DVP_TRADE_STATUSES.join(","),
    availability = DVP_SETTLEMENT_AVAILABILITY.join(",");
  const result = await invoke(
    [
      "dvp",
      "trades",
      "list",
      "--status",
      statuses,
      "--settlement-availability",
      availability,
      "--search",
      "USDC +%&",
      "--limit",
      "100",
    ],
    response({ trades: [trade] })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    status: statuses,
    settlementAvailability: availability,
    q: "USDC +%&",
    limit: "100",
  });
  assert.deepEqual(JSON.parse(result.stdout).data.trades, [trade]);
  const empty = await invoke(["dvp", "trades", "list"], response({ trades: [] }));
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(new URL(empty.requests[0].url).search, "");
});

test("inbound discovery uses its literal route and does not enrich withheld tenant fields", async () => {
  const result = await invoke(
    ["dvp", "trades", "inbound", "list"],
    response({ trades: [inbound] })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/dvp/trades/inbound");
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.deepEqual(JSON.parse(result.stdout).data.trades, [inbound]);
  const collision = await invoke(["dvp", "trades", "get", "inbound"], response({ trade }));
  assert.equal(collision.code, 2);
  assert.equal(collision.requests.length, 0);
});

test("detail reads encode one ID segment and preserve closed-unknown state and escrow history", async () => {
  const transfers = [
    {
      signature: "signature_fixture",
      direction: "in",
      kind: "deposit",
      amount,
      slot: "9007199254740993",
      blockTime: null,
      feePayer: SOL_MINT,
    },
  ];
  const observed = {
    ...trade,
    status: "closed_unknown",
    legs: { ...trade.legs, a: { ...leg, transfers } },
  };
  const result = await invoke(
    ["dvp", "trades", "get", "trade/with?#"],
    response({ trade: observed })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/dvp/trades/trade%2Fwith%3F%23");
  assert.deepEqual(JSON.parse(result.stdout).data.trade, observed);
});

test("fund and reclaim name only the side and optional exact SDP wallet ID", async () => {
  for (const action of ["fund", "reclaim"]) {
    const data = { tradeId: trade.id, leg: "b", amount, signature: "signature_fixture" };
    const result = await invoke(
      [
        "dvp",
        "trades",
        action,
        trade.id,
        "--side",
        "b",
        "--custody-wallet-id",
        "cwlt_b",
        "--idempotency-key",
        key,
      ],
      response(data)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), { side: "b", walletId: "cwlt_b" });
    assert.equal(new URL(result.requests[0].url).pathname, `/v1/dvp/trades/${trade.id}/${action}`);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
  }
  const omitted = await invoke(
    ["dvp", "trades", "fund", trade.id, "--side", "a"],
    response({ tradeId: trade.id, leg: "a", amount: "1", signature: "signature_fixture" })
  );
  assert.equal(omitted.code, 0, omitted.stderr);
  assert.deepEqual(body(omitted.requests[0]), { side: "a" });
  const explicitNull = await invoke(
    ["dvp", "trades", "reclaim", trade.id, "--data", '{"side":"a","walletId":null}'],
    response({ tradeId: trade.id, leg: "a", amount: "1", signature: "signature_fixture" })
  );
  assert.equal(explicitNull.code, 0, explicitNull.stderr);
  assert.deepEqual(body(explicitNull.requests[0]), { side: "a", walletId: null });
});

test("settle and cancel are bodyless and preserve unconfirmed closes without polling", async () => {
  for (const action of ["settle", "cancel"]) {
    const data = { tradeId: trade.id, action, signature: "close_fixture", confirmed: false };
    const result = await invoke(
      ["dvp", "trades", action, trade.id, "--idempotency-key", key],
      response(data)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(new Headers(result.requests[0].init.headers).get("content-type"), null);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
  }
});

test("all documented refusal reasons are retained as structured JSON without retries", async () => {
  for (const [action, reasons] of [
    ["fund", Object.values(DVP_LEG_REFUSAL)],
    ["settle", Object.values(DVP_CLOSE_REFUSAL)],
  ] as const) {
    for (const reason of reasons) {
      const args = ["dvp", "trades", action, trade.id, "--idempotency-key", key];
      if (action === "fund") args.push("--side", "a");
      const result = await invoke(
        args,
        Response.json(
          {
            error: { code: "CONFLICT", message: "Trade action refused", details: { reason } },
            meta: {},
          },
          { status: 409, headers: { "x-request-id": "req_header" } }
        )
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.requests.length, 1);
      assert.deepEqual(JSON.parse(result.stderr).error, {
        code: "CONFLICT",
        message: "Trade action refused",
        status: 409,
        requestId: "req_header",
        details: { reason },
      });
    }
  }
});

test("structured error details redact account credentials recursively in keys and arrays", async () => {
  const secret = "credential/with?reserved";
  const result = await invoke(
    ["dvp", "trades", "settle", trade.id],
    Response.json(
      {
        error: {
          code: "CONFLICT",
          message: "Refused",
          details: {
            reason: DVP_CLOSE_REFUSAL.legMoving,
            nested: [{ [secret]: encodeURIComponent(secret) }, secret, false, 0, null],
          },
        },
        meta,
      },
      { status: 409 }
    ),
    { env: { SDP_API_KEY: secret } }
  );
  assert.equal(result.code, 1);
  assert(!result.stderr.includes(secret));
  assert(!result.stderr.includes(encodeURIComponent(secret)));
  assert.deepEqual(JSON.parse(result.stderr).error.details, {
    reason: DVP_CLOSE_REFUSAL.legMoving,
    nested: [{ "[REDACTED]": "[REDACTED]" }, "[REDACTED]", false, 0, null],
  });
});

test("structured errors also redact bearer-link credentials without requiring account auth", async () => {
  const token = "bearer/with?reserved";
  const result = await invoke(
    ["payment-links", "get", token],
    Response.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Missing",
          details: [token, { value: encodeURIComponent(token) }],
        },
      },
      { status: 404 }
    ),
    { env: {} }
  );
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr).error.details, [
    "[REDACTED]",
    { value: "[REDACTED]" },
  ]);
  assert.equal(new Headers(result.requests[0].init.headers).get("authorization"), null);
});

test("invalid parties, numeric quantities and unexpected create terms fail before network access", async () => {
  for (const payload of [
    { ...terms, partyA: {} },
    { ...terms, partyA: { walletId: "cwlt_a", address: SOL_MINT } },
    { ...terms, partyB: { address: SOL_MINT, extra: "typo" } },
    { ...terms, amountA: 100 },
    { ...terms, amountB: "1.5" },
    { ...terms, expiryTimestamp: 1 },
    { ...terms, nonce: "1" },
    { ...terms, refString: "x".repeat(65) },
  ]) {
    const result = await invoke(
      ["dvp", "trades", "create", "--data", JSON.stringify(payload)],
      response({ trade }, 201)
    );
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});

test("range and address refusals the OpenAPI cannot express remain server-owned", async () => {
  for (const payload of [
    { ...terms, amountA: "18446744073709551616" },
    { ...terms, mintA: "short" },
  ]) {
    const result = await invoke(
      ["dvp", "trades", "create", "--data", JSON.stringify(payload)],
      error(400, "BAD_REQUEST", "Invalid trade terms")
    );
    assert.equal(result.code, 1);
    assert.deepEqual(body(result.requests[0]), payload);
    assert.equal(result.requests.length, 1);
  }
});

test("inbound selectors, funding quantities and unsupported mutation options are refused", async () => {
  for (const args of [
    ["dvp", "trades", "inbound", "list", "--owner-address", SOL_MINT],
    ["dvp", "trades", "inbound", "list", "--search", "x"],
    ["dvp", "trades", "fund", trade.id, "--side", "a", "--amount", "1"],
    ["dvp", "trades", "fund", trade.id, "--side", "c"],
    ["dvp", "trades", "fund", trade.id],
    ["dvp", "trades", "fund", trade.id, "--wallet-id", "provider_wallet", "--side", "a"],
    ["dvp", "trades", "settle", trade.id, "--data", "{}"],
    ["dvp", "trades", "list", "--limit", "101"],
    ["dvp", "trades", "list", "--idempotency-key", key],
    ["dvp", "trades", "list", "--cursor", "cursor"],
    [...createArgs, "--data", JSON.stringify(terms)],
  ]) {
    const result = await invoke(args, error());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});

test("feature gates, missing grants, hidden trades, quotas and uncertain failures never trigger another action", async () => {
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [403, "INSUFFICIENT_PERMISSIONS"],
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [422, "TRANSACTION_FAILED"],
    [502, "SOLANA_RPC_ERROR"],
  ] as const) {
    const result = await invoke(
      ["dvp", "trades", "settle", trade.id, "--idempotency-key", key],
      error(status, code)
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, code);
  }
  const lost = await invoke(createArgs, response({ trade }, 201), {
    failure: new TypeError("Connection lost"),
  });
  assert.equal(lost.code, 1);
  assert.equal(lost.requests.length, 1);
});

test("malformed DvP success bodies do not print partial trades or close evidence", async () => {
  for (const [args, data] of [
    [["dvp", "trades", "get", trade.id], { trade: { ...trade, nonce: 123 } }],
    [["dvp", "trades", "get", trade.id], { trade: { ...trade, legs: {} } }],
    [
      ["dvp", "trades", "settle", trade.id],
      { tradeId: trade.id, action: "settle", signature: "fixture", confirmed: "false" },
    ],
  ] as const) {
    const result = await invoke([...args], response(data));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
