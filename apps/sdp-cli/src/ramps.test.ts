import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STAGED_PROVIDER_REFUSAL_REASONS } from "@sdp/types/custody";
import { RAMP_AMOUNT_LIMIT_REASONS } from "@sdp/types/payments";
import { operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_ramps", timestamp: "2026-01-01T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "ramps-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "ramps-key", SDP_API_URL: session.SDP_API_URL };
const amount = "9007199254740993.000001";
const onEstimate = { assetRail: "usdc.solana", fiatCurrency: "USD", fiatAmount: amount };
const offEstimate = { assetRail: "usdc.solana", fiatCurrency: "EUR", cryptoAmount: amount };
const onQuote = {
  ...onEstimate,
  provider: "moonpay",
  counterpartyId: "cpty_example",
  destinationCustodyWalletId: "cwlt_destination",
};
const offQuote = {
  assetRail: "usdc.solana",
  cryptoAmount: amount,
  provider: "moonpay",
  counterpartyId: "cpty_example",
  sourceCustodyWalletId: "cwlt_source",
};
const onArgs = ["--asset-rail", "usdc.solana", "--fiat-currency", "USD", "--fiat-amount", amount];
const offArgs = [
  "--asset-rail",
  "usdc.solana",
  "--fiat-currency",
  "EUR",
  "--crypto-amount",
  amount,
];
const onQuoteArgs = [
  ...onArgs,
  "--provider",
  "moonpay",
  "--counterparty-id",
  "cpty_example",
  "--destination-custody-wallet-id",
  "cwlt_destination",
];
const offQuoteArgs = [
  "--asset-rail",
  "usdc.solana",
  "--crypto-amount",
  amount,
  "--provider",
  "moonpay",
  "--counterparty-id",
  "cpty_example",
  "--source-custody-wallet-id",
  "cwlt_source",
];
const rampCommands = [
  ["onramps", "supported-pairs", "list"],
  ["offramps", "supported-pairs", "list"],
  ["onramps", "estimate", ...onArgs],
  ["offramps", "estimate", ...offArgs],
  ["onramps", "start", ...onQuoteArgs],
  ["offramps", "start", ...offQuoteArgs],
  ["ramps", "cancel", "--transfer-id", "xfr_example"],
  ["ramps", "simulate-settlement", "--transfer-id", "xfr_example"],
];
const hosted = {
  id: "quote_example",
  provider: "moonpay",
  status: "pending",
  deliveryMode: "hosted",
  hostedUrl: "https://checkout.example.test/start?signature=fixture",
};
const widget = {
  id: "quote_widget",
  provider: "stripe",
  status: "pending",
  deliveryMode: "session_widget",
  clientSecret: "checkout_secret_fixture",
  sessionId: "session_fixture",
  publishableKey: "pk_fixture",
  redirectUrl: "https://checkout.example.test/return",
};
const estimate = {
  provider: "moonpay",
  direction: "onramp",
  fiatCurrency: "USD",
  assetRail: "usdc.solana",
  fiatAmount: amount,
  cryptoAmount: "8999999999999999.000001",
  exchangeRate: "0.999999999999999999",
  totalFiatAmount: "9007199254740994.000001",
  fees: {
    currency: "USD",
    total: "1.000000",
    network: "0",
    networkCurrency: "USD",
    provider: "1.000000",
    providerCurrency: "USD",
  },
  minFiatAmount: "20",
  maxFiatAmount: "99999999999999999",
  expiresAt: meta.timestamp,
};
const transfer = {
  id: "xfr_example",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  custodyWalletId: "cwlt_source",
  providerWalletId: "provider_wallet_id",
  type: "offramp",
  kind: "offramp",
  direction: "outbound",
  status: "canceled",
  signature: null,
  serializedTx: null,
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  rampsMemo: { correlation: "order_42" },
  amount,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
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
    env: options.env ?? session,
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
function quoteResponse(quote = hosted) {
  return Response.json({ data: { quote, transferId: "xfr_example" }, meta });
}
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function emptyEstimates() {
  return Response.json({ data: { estimates: [] }, meta });
}
function apiError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message }, meta }, { status });
}

test("all ramp commands have offline help and checkout credential warnings", async () => {
  for (const args of [
    ["onramps"],
    ["offramps"],
    ["ramps"],
    ...rampCommands.map((args) => [...args, "--help"]),
  ]) {
    const result = await invoke(args, emptyEstimates(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(!result.stdout.includes("--idempotency-key"));
    if (args[1] === "quote") assert(result.stdout.includes("Provider checkout credentials"));
  }
});

test("ramp contracts derive grants and project selection without replay-key support", () => {
  for (const [id, action] of [
    ["listPaymentOnrampCurrencies", "onramp.read"],
    ["listPaymentOfframpCurrencies", "offramp.read"],
    ["estimatePaymentOnramp", "onramp.read"],
    ["estimatePaymentOfframp", "offramp.read"],
    ["createPaymentOnrampQuote", "onramp.execute"],
    ["createPaymentOfframpQuote", "offramp.execute"],
    ["cancelPaymentRampTransfer", "ramp_transfers.manage"],
    ["simulateSandboxTransfer", "ramp_transfers.manage"],
  ]) {
    const op = operationById(id);
    assert.deepEqual(op.authorization, { kind: "action", action });
    assert.equal(op.sessionOnly, false);
    assert(op.parameters.some((p) => p.name === "x-project-id"));
    assert(!op.parameters.some((p) => p.name.toLowerCase() === "idempotency-key"));
    assert.equal(op.returnsRampClientSecret, id.includes("Quote"));
  }
});

test("every session ramp operation requires a project before network access", async () => {
  for (const args of rampCommands) {
    const result = await invoke(args, emptyEstimates(), { env: { SDP_TOKEN: session.SDP_TOKEN } });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("currency support uses direction-specific query selectors and preserves provider coverage", async () => {
  for (const [group, source, dest] of [
    ["onramps", "USD", "usdc.solana"],
    ["offramps", "usdc.solana", "EUR"],
  ]) {
    const envelope = {
      data: {
        currencies: { sources: [source], destinations: [dest] },
        pairs: [{ source, dest, providers: ["moonpay"] }],
        providerDetails: {
          moonpay: {
            currencies: { USD: { min: "20.00", max: null } },
            countrySupport: { coverage: "all-currencies", countries: ["US"] },
            entityTypes: ["individual"],
          },
          stripe: {
            currencies: { USD: { min: null, max: "999.00" } },
            countrySupport: { coverage: "by-country", countries: { US: ["USD"] } },
            entityTypes: ["business"],
          },
        },
        supportHash: "sha256:fixture",
      },
      meta,
    };
    const result = await invoke(
      [
        group,
        "supported-pairs",
        "list",
        "--source",
        source,
        "--dest",
        dest,
        "--provider",
        "moonpay",
      ],
      Response.json(envelope)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(result.requests.length, 1);
    const request = result.requests[0];
    assert.equal(request.init.method, "GET");
    const url = new URL(request.url);
    assert.equal(
      url.pathname,
      `/v1/payments/ramps/${group === "onramps" ? "onramp" : "offramp"}/supported-pairs`
    );
    assert.deepEqual(Object.fromEntries(url.searchParams), { source, dest, provider: "moonpay" });
    assert.equal(new Headers(request.init.headers).get("x-project-id"), session.SDP_PROJECT_ID);
    assert.equal(request.init.body, undefined);
  }
});

test("empty currency support and unreported coverage are preserved", async () => {
  const envelope = {
    data: {
      currencies: { sources: [], destinations: [] },
      pairs: [],
      providerDetails: {
        moonpay: { currencies: {}, countrySupport: { coverage: "unreported" }, entityTypes: [] },
      },
      supportHash: "sha256:empty",
    },
    meta,
  };
  const result = await invoke(["onramps", "supported-pairs", "list"], Response.json(envelope), {
    env: apiKey,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), envelope);
  assert.equal(
    new Headers(result.requests[0].init.headers).get("authorization"),
    "Bearer ramps-key"
  );
});

test("estimates preserve all provider outcomes and decimal strings in a single request", async () => {
  for (const [group, args, expected] of [
    ["onramps", onArgs, onEstimate],
    ["offramps", offArgs, offEstimate],
  ] as const) {
    const envelope = {
      data: {
        estimates: [
          {
            provider: "moonpay",
            status: "ok",
            estimate: { ...estimate, direction: group === "onramps" ? "onramp" : "offramp" },
          },
          { provider: "stripe", status: "unsupported" },
          { provider: "stripe", status: "error", error: "Provider unavailable" },
          ...STAGED_PROVIDER_REFUSAL_REASONS.map((reason) => ({
            provider: "stripe",
            status: "error",
            reason,
            error: "Provider access refused",
          })),
          ...RAMP_AMOUNT_LIMIT_REASONS.map((reason) => ({
            provider: "moonpay",
            status: "error",
            reason,
            error: "Amount outside bounds",
            limit: { amount: "20.000000", currency: "USD" },
          })),
        ],
      },
      meta,
    };
    const result = await invoke([group, "estimate", ...args], Response.json(envelope));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].init.method, "POST");
    assert.equal(new URL(result.requests[0].url).search, "");
    assert.deepEqual(body(result.requests[0]), expected);
  }
});

test("empty estimates and estimates containing only provider errors remain successful API responses", async () => {
  for (const estimates of [
    [],
    [{ provider: "stripe", status: "error", error: "Service unavailable" }],
  ]) {
    const envelope = { data: { estimates }, meta };
    const result = await invoke(["onramps", "estimate", ...onArgs], Response.json(envelope));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(result.requests.length, 1);
  }
});

test("on-ramp quotes use exact SDP destination IDs and preserve hosted checkout without following it", async () => {
  const result = await invoke(
    ["onramps", "start", ...onQuoteArgs, "--ramps-memo", '{"order":"42","empty":"nonempty"}'],
    quoteResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    ...onQuote,
    rampsMemo: { order: "42", empty: "nonempty" },
  });
  assert.equal(result.requests.length, 1);
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/payments/ramps/onramp/start");
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    data: { quote: hosted, transferId: "xfr_example" },
    meta,
  });
});

test("Stripe widget credentials are returned only in the requested JSON response", async () => {
  const result = await invoke(
    ["onramps", "start", "--data", JSON.stringify({ ...onQuote, provider: "stripe" })],
    Response.json({ data: { quote: widget, transferId: "xfr_widget" }, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).data, { quote: widget, transferId: "xfr_widget" });
  assert.equal(result.requests.length, 1);
  assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
});

test("off-ramp quotes leave optional currency absent and do not fund the returned transfer", async () => {
  const result = await invoke(
    ["offramps", "start", ...offQuoteArgs, "--ramps-memo", "{}"],
    quoteResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { ...offQuote, rampsMemo: {} });
  assert.equal(result.requests.length, 1);
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/payments/ramps/offramp/start");
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.equal(JSON.parse(result.stdout).data.transferId, "xfr_example");
});

test("off-ramp quote JSON, file and stdin preserve optional currency and correlation strings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-ramp-input-"));
  try {
    const payload = { ...offQuote, fiatCurrency: "EUR", rampsMemo: { reference: "00042" } };
    const input = JSON.stringify(payload);
    const filename = path.join(directory, "quote.json");
    await writeFile(filename, input);
    for (const source of [input, `@${filename}`, "-"]) {
      const result = await invoke(["offramps", "start", "--data", source], quoteResponse(), {
        stdin: input,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), payload);
      assert.equal(result.requests.length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation sends the SDP transfer ID and preserves the returned cancellation state", async () => {
  const envelope = { data: { transfer }, meta };
  for (const args of [
    ["--transfer-id", transfer.id],
    ["--data", JSON.stringify({ transferId: transfer.id })],
  ]) {
    const result = await invoke(["ramps", "cancel", ...args], Response.json(envelope));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), { transferId: transfer.id });
    assert.equal(new URL(result.requests[0].url).pathname, "/v1/payments/ramps/transfers/cancel");
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(result.requests.length, 1);
  }
});

test("sandbox simulation supports the documented empty response", async () => {
  const result = await invoke(
    ["ramps", "simulate-settlement", "--transfer-id", transfer.id],
    new Response(null, { status: 204 })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(body(result.requests[0]), { transferId: transfer.id });
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/payments/ramps/sandbox/simulate");
  assert.equal(result.requests.length, 1);
});

test("simulation preserves current provider, environment and state refusals", async () => {
  for (const [status, code, message] of [
    [400, "BAD_REQUEST", "Sandbox simulation is not available for provider: moonpay."],
    [403, "FORBIDDEN", "Sandbox simulation is only available in sandbox."],
    [409, "CONFLICT", "Transfer status changed."],
  ] as const) {
    const result = await invoke(
      ["ramps", "simulate-settlement", "--transfer-id", transfer.id],
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
});

test("unsupported Stripe off-ramp is returned once without trying another provider", async () => {
  const result = await invoke(
    ["offramps", "start", "--data", JSON.stringify({ ...offQuote, provider: "stripe" })],
    apiError(400, "BAD_REQUEST", "Stripe off-ramp is not supported.")
  );
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(body(result.requests[0]).provider, "stripe");
  assert.equal(JSON.parse(result.stderr).error.message, "Stripe off-ramp is not supported.");
});

test("ramp errors, conflicts, rate limits and provider failures never trigger retries", async () => {
  for (const status of [400, 403, 404, 409, 429, 502, 503]) {
    const result = await invoke(
      ["offramps", "start", ...offQuoteArgs],
      apiError(status, "PROVIDER_FAILURE", "Provider refused the request.")
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.status, status);
    assert.equal(result.requests.length, 1);
  }
  const result = await invoke(["onramps", "start", ...onQuoteArgs], quoteResponse(), {
    failure: new TypeError("connection lost"),
  });
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "NETWORK_ERROR");
});

test("invalid ramp selectors and payloads fail before contacting SDP", async () => {
  for (const args of [
    ["onramps", "supported-pairs", "list", "--source", "usdc.solana"],
    ["offramps", "supported-pairs", "list", "--dest", "usdc.solana"],
    ["onramps", "estimate", "--data", JSON.stringify({ ...onEstimate, fiatAmount: 100 })],
    ["offramps", "estimate", "--data", JSON.stringify({ ...offEstimate, fiatCurrency: "XXX" })],
    ["onramps", "start", "--data", JSON.stringify({ ...onQuote, assetRail: "usdc.ethereum" })],
    ["onramps", "start", "--data", JSON.stringify({ ...onQuote, destinationCustodyWalletId: "" })],
    ["offramps", "start", "--data", JSON.stringify({ ...offQuote, provider: "privy" })],
    ["offramps", "start", "--data", JSON.stringify({ ...offQuote, bankAccount: "unexpected" })],
    ["onramps", "start", ...onQuoteArgs, "--ramps-memo", "[]"],
    ["onramps", "start", ...onQuoteArgs, "--ramps-memo", '{"reference":42}'],
    ["offramps", "start", ...offQuoteArgs, "--ramps-memo", '{"reference":null}'],
    ["ramps", "cancel"],
    ["ramps", "simulate-settlement", "--data", '{"transferId":"xfr_example","status":"completed"}'],
  ]) {
    const result = await invoke(args, quoteResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 0);
  }
});

test("cross-direction flags, estimate provider selection and retry keys are refused", async () => {
  for (const args of [
    ["onramps", "estimate", ...onArgs, "--provider", "moonpay"],
    ["onramps", "start", ...onQuoteArgs, "--crypto-amount", "1"],
    ["offramps", "start", ...offQuoteArgs, "--fiat-amount", "1"],
    ["offramps", "start", ...offQuoteArgs, "--destination-custody-wallet-id", "cwlt_wrong"],
    ...rampCommands.map((args) => [...args, "--idempotency-key", "not-supported"]),
    ["onramps", "start", ...onQuoteArgs, "--data", JSON.stringify(onQuote)],
  ]) {
    const result = await invoke(args, quoteResponse());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});

test("malformed ramp success payloads cannot leak partial responses to stdout", async () => {
  for (const [args, payload] of [
    [["onramps", "start", ...onQuoteArgs], { data: { quote: widget }, meta }],
    [
      ["onramps", "estimate", ...onArgs],
      {
        data: {
          estimates: [
            { provider: "moonpay", status: "ok", estimate: { ...estimate, cryptoAmount: 10 } },
          ],
        },
        meta,
      },
    ],
    [["offramps", "supported-pairs", "list"], { data: { pairs: [] }, meta }],
  ] as const) {
    const result = await invoke([...args], Response.json(payload));
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert(!result.stderr.includes(widget.clientSecret));
    assert.equal(result.requests.length, 1);
  }
});
