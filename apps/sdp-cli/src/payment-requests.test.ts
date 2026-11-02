import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PAYMENT_REQUEST_STATUSES } from "@sdp/types/payments";
import { getSdpDocsOrigin } from "@sdp/types/site";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_payment_request", timestamp: "2026-01-01T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "request-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "request-api-key", SDP_API_URL: session.SDP_API_URL };
const publicToken = "link_bearer_fixture";
const paymentRequest = {
  id: "preq_example",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  walletId: "provider_wallet_id",
  destinationAddress: SOL_MINT,
  token: SOL_MINT,
  amount: "123.000000001",
  reference: SOL_MINT,
  status: "awaiting_payment",
  expiresAt: null,
  fulfilledByTransferId: null,
  paidLate: false,
  lastCheckedAt: null,
  canceledByApiKeyId: null,
  canceledByUserId: null,
  canceledAt: null,
  lifecycle: [{ status: "awaiting_payment", at: meta.timestamp }],
  createdBy: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const linkDetails = {
  amount: paymentRequest.amount,
  token: SOL_MINT,
  tokenSymbol: "SOL",
  recipient: SOL_MINT,
  reference: SOL_MINT,
  status: "awaiting_payment",
  expiresAt: null,
  network: "devnet",
  solanaPayUrl: `solana:https://api.example.com/pay/${publicToken}/tx`,
};
const metadata = { label: "Solana Developer Platform", icon: `${getSdpDocsOrigin()}/icon.svg` };
const prepared = { transaction: "AQIDBA==", message: "Pay the requested amount" };
const createArgs = [
  "payment-requests",
  "create",
  "--wallet-id",
  paymentRequest.walletId,
  "--asset",
  SOL_MINT,
  "--amount",
  paymentRequest.amount,
];
const accountCommands = [
  createArgs,
  ["payment-requests", "list"],
  ["payment-requests", "get", paymentRequest.id],
  ["payment-requests", "link-token", "get", paymentRequest.id],
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
function createdResponse() {
  return Response.json({ data: { ...paymentRequest, publicToken }, meta }, { status: 201 });
}
function requestResponse() {
  return Response.json({ data: paymentRequest, meta });
}
function headers(request: RecordedRequest) {
  return new Headers(request.init.headers);
}
function requestBody(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function assertNoAccountHeaders(request: RecordedRequest) {
  assert.equal(headers(request).get("authorization"), null);
  assert.equal(headers(request).get("x-project-id"), null);
  assert.equal(headers(request).get("idempotency-key"), null);
}

test("request and link help describes bearer authorization, provider IDs and payer signing", async () => {
  for (const args of [
    ["payment-requests"],
    ["payment-links"],
    ...accountCommands.map((args) => [...args, "--help"]),
    ["payment-links", "get", "--help"],
    ["payment-links", "metadata", "get", "--help"],
    ["payment-links", "transactions", "build-sponsored-transaction", "--help"],
  ]) {
    const result = await invoke(args, requestResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[0] === "payment-links" && args[1] !== undefined)
      assert(result.stdout.includes("<publicToken>"));
    if (args[1] === "prepare") assert(result.stdout.includes("sign"));
    if (args[0] === "payment-requests" && args[1] === "link")
      assert(result.stdout.includes("payment_requests.manage"));
  }
});

test("authenticated request operations require account credentials and session project selection", async () => {
  for (const args of accountCommands) {
    for (const env of [{}, { SDP_TOKEN: session.SDP_TOKEN }]) {
      const result = await invoke(args, requestResponse(), { env });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.requests.length, 0);
    }
  }
});

test("bearer disclosures are distinguished from read records in the contract", () => {
  assert.equal(operationById("createPaymentRequest").returnsPaymentLinkToken, true);
  assert.equal(operationById("getPaymentRequestLink").returnsPaymentLinkToken, true);
  assert.equal(operationById("getPaymentRequest").returnsPaymentLinkToken, false);
  assert.equal(operationById("listPaymentRequests").returnsPaymentLinkToken, false);
  assert.deepEqual(operationById("getPaymentRequestLink").authorization, {
    kind: "action",
    action: "payment_requests.manage",
  });
  for (const id of ["getPaymentLink", "getPaymentLinkMetadata", "preparePaymentLinkTransaction"]) {
    assert.deepEqual(operationById(id).authorization, { kind: "payment-link" });
    assert.equal(operationById(id).sessionOnly, false);
  }
});

test("creation forwards a provider wallet ID, exact amount, mint and optional expiration once", async () => {
  const result = await invoke(
    [...createArgs, "--expires-at", "2026-12-01T00:00:00.000Z"],
    createdResponse(),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/payments/requests");
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(requestBody(result.requests[0]), {
    walletId: paymentRequest.walletId,
    token: SOL_MINT,
    amount: paymentRequest.amount,
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  assert.equal(headers(result.requests[0]).get("authorization"), "Bearer request-api-key");
  assert.equal(headers(result.requests[0]).get("idempotency-key"), null);
  assert.equal(JSON.parse(result.stdout).data.publicToken, publicToken);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
});

test("omitted expiration stays omitted while JSON null is preserved through files and stdin", async () => {
  const omitted = await invoke(createArgs, createdResponse());
  assert.equal(omitted.code, 0, omitted.stderr);
  assert.equal(requestBody(omitted.requests[0]).expiresAt, undefined);
  assert.equal(headers(omitted.requests[0]).get("x-project-id"), session.SDP_PROJECT_ID);
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-payment-request-"));
  try {
    const body = {
      walletId: paymentRequest.walletId,
      token: SOL_MINT,
      amount: paymentRequest.amount,
      expiresAt: null,
    };
    const text = JSON.stringify(body);
    const file = path.join(directory, "request.json");
    await writeFile(file, text);
    for (const source of [text, `@${file}`, "-"]) {
      const result = await invoke(
        ["payment-requests", "create", "--data", source],
        createdResponse(),
        { stdin: text }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(requestBody(result.requests[0]), body);
      assert.equal(result.requests.length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("request lists preserve their nested pagination and lifecycle without fetching link tokens", async () => {
  for (const status of PAYMENT_REQUEST_STATUSES) {
    const row = { ...paymentRequest, status };
    const data = { paymentRequests: [row], total: 12, page: 2, pageSize: 5 };
    const result = await invoke(
      ["payment-requests", "list", "--status", status, "--page", "2", "--page-size", "5"],
      Response.json({ data, meta }),
      { env: apiKey }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
      status,
      page: "2",
      pageSize: "5",
    });
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});

test("request detail and manage-level link reads use the SDP request ID and distinct payloads", async () => {
  const detail = await invoke(["payment-requests", "get", "request/with?#"], requestResponse());
  assert.equal(detail.code, 0, detail.stderr);
  assert.equal(
    detail.requests[0].url,
    "http://localhost:8787/v1/payments/requests/request%2Fwith%3F%23"
  );
  assert.deepEqual(JSON.parse(detail.stdout).data, paymentRequest);
  const data = { id: paymentRequest.id, publicToken };
  const link = await invoke(
    ["payment-requests", "link-token", "get", paymentRequest.id],
    Response.json({ data, meta })
  );
  assert.equal(link.code, 0, link.stderr);
  assert.equal(
    link.requests[0].url,
    `http://localhost:8787/v1/payments/requests/${paymentRequest.id}/link-token`
  );
  assert.deepEqual(JSON.parse(link.stdout), { data, meta });
  assert.equal(link.stderr, "");
});

test("public link details work with no account credential and retain the bare JSON payload", async () => {
  const result = await invoke(["payment-links", "get", publicToken], Response.json(linkDetails), {
    env: { SDP_API_URL: session.SDP_API_URL },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, `http://localhost:8787/pay/${publicToken}`);
  assert.deepEqual(JSON.parse(result.stdout), linkDetails);
  assertNoAccountHeaders(result.requests[0]);
});

test("link calls omit explicit and ambient credentials and ignore stale tenant selectors", async () => {
  const env = {
    SDP_API_URL: session.SDP_API_URL,
    SDP_API_KEY: "ambient-api-key",
    SDP_TOKEN: "ambient-session",
    SDP_PROJECT_ID: "",
    SDP_ORGANIZATION_ID: "",
  };
  const calls = [
    [["payment-links", "get", publicToken], linkDetails],
    [["payment-links", "metadata", "get", publicToken], metadata],
    [
      [
        "payment-links",
        "transactions",
        "build-sponsored-transaction",
        publicToken,
        "--account",
        SOL_MINT,
      ],
      prepared,
    ],
  ] as const;
  for (const [args, data] of calls) {
    const result = await invoke(
      [
        ...args,
        "--api-key",
        "ignored-api-key",
        "--token",
        "ignored-session",
        "--project",
        "",
        "--organization",
        "",
      ],
      Response.json(data),
      { env }
    );
    assert.equal(result.code, 0, result.stderr);
    assertNoAccountHeaders(result.requests[0]);
    assert.equal(result.requests.length, 1);
  }
});

test("link tokens stay within one path segment while preserving proxy base paths", async () => {
  const token = "bearer/with?#";
  const result = await invoke(
    ["payment-links", "metadata", "get", token],
    Response.json(metadata),
    {
      env: { SDP_API_URL: "http://localhost:8787/proxy/" },
    }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/proxy/pay/bearer%2Fwith%3F%23/tx");
  assert.deepEqual(JSON.parse(result.stdout), metadata);
});

test("non-payable link details preserve a null Solana Pay URL and stored network", async () => {
  const data = { ...linkDetails, status: "paid", network: "mainnet-beta", solanaPayUrl: null };
  const result = await invoke(["payment-links", "get", publicToken], Response.json(data));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), data);
  assert.equal(result.requests.length, 1);
});

test("transaction preparation sends the payer account and returns unsigned-by-payer bytes without broadcasting", async () => {
  for (const args of [
    ["--account", SOL_MINT],
    ["--data", JSON.stringify({ account: SOL_MINT })],
  ]) {
    const result = await invoke(
      ["payment-links", "transactions", "build-sponsored-transaction", publicToken, ...args],
      Response.json(prepared),
      { env: { SDP_API_URL: session.SDP_API_URL } }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].url, `http://localhost:8787/pay/${publicToken}/tx`);
    assert.equal(result.requests[0].init.method, "POST");
    assert.deepEqual(requestBody(result.requests[0]), { account: SOL_MINT });
    assertNoAccountHeaders(result.requests[0]);
    assert.deepEqual(JSON.parse(result.stdout), prepared);
    assert.equal(result.requests.length, 1);
  }
});

test("bearer tokens are redacted from API error text, codes and request IDs", async () => {
  const token = "private/link?token";
  const encoded = encodeURIComponent(token);
  const result = await invoke(
    ["payment-links", "transactions", "build-sponsored-transaction", token, "--account", SOL_MINT],
    Response.json(
      {
        error: { code: `EXPIRED_${token}`, message: `Request ${token}, encoded ${encoded}` },
        meta: { requestId: `req_${token}` },
      },
      { status: 400 }
    )
  );
  assert.equal(result.code, 1);
  assert(!result.stderr.includes(token));
  assert(!result.stderr.includes(encoded));
  assert(result.stderr.includes("[REDACTED]"));
  assert.equal(result.stdout, "");
});

test("bearer tokens do not leak through invalid-response, header, network or redirect failures", async () => {
  for (const response of [
    new Response("not json", { status: 200, headers: { "x-request-id": publicToken } }),
    Response.json({}, { status: 200, headers: { "x-request-id": publicToken } }),
    new Response(null, {
      status: 302,
      headers: { location: `https://example.com/${publicToken}`, "x-request-id": publicToken },
    }),
  ]) {
    const result = await invoke(["payment-links", "get", publicToken], response);
    assert.equal(result.code, 1);
    assert(!result.stderr.includes(publicToken));
    assert.equal(result.stdout, "");
  }
  const failed = await invoke(["payment-links", "get", publicToken], Response.json(linkDetails), {
    failure: new Error(`fetch failed: ${publicToken}`),
  });
  assert.equal(failed.code, 1);
  assert(!failed.stderr.includes(publicToken));
});

test("rate limits, paid/expired requests and ambiguous preparation outcomes are never retried", async () => {
  for (const [status, code] of [
    [400, "BAD_REQUEST"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    const result = await invoke(
      [
        "payment-links",
        "transactions",
        "build-sponsored-transaction",
        publicToken,
        "--account",
        SOL_MINT,
      ],
      Response.json(
        { error: { code, message: "Request unavailable" } },
        { status, headers: { "retry-after": "30" } }
      )
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.status, status);
    assertNoAccountHeaders(result.requests[0]);
  }
  const timeout = await invoke(
    [
      "payment-links",
      "transactions",
      "build-sponsored-transaction",
      publicToken,
      "--account",
      SOL_MINT,
    ],
    Response.json(prepared),
    { failure: new DOMException(publicToken, "TimeoutError") }
  );
  assert.equal(timeout.code, 1);
  assert.equal(timeout.requests.length, 1);
  assert(!timeout.stderr.includes(publicToken));
});

test("invalid request/link arguments and idempotency flags stop before HTTP", async () => {
  const cases = [
    ["payment-requests", "create"],
    [...createArgs, "--wallet-id", "second_wallet"],
    [...createArgs, "--expires-at", "invalid"],
    [...createArgs, "--idempotency-key", "secret-response"],
    [...createArgs, "--data", "{}"],
    [
      "payment-requests",
      "create",
      "--data",
      JSON.stringify({ walletId: paymentRequest.walletId, token: SOL_MINT, amount: 1 }),
    ],
    [
      "payment-requests",
      "create",
      "--data",
      JSON.stringify({
        walletId: paymentRequest.walletId,
        token: SOL_MINT,
        amount: "1",
        destinationAddress: SOL_MINT,
      }),
    ],
    ["payment-requests", "list", "--status", "processing"],
    ["payment-requests", "list", "--page", "0"],
    ["payment-requests", "get", ".."],
    ["payment-requests", "link-token", "get"],
    ["payment-links", "get"],
    ["payment-links", "get", ".."],
    ["payment-links", "transactions", "build-sponsored-transaction", publicToken],
    ["payment-links", "transactions", "build-sponsored-transaction", publicToken, "--data", "{}"],
    [
      "payment-links",
      "transactions",
      "build-sponsored-transaction",
      publicToken,
      "--account",
      SOL_MINT,
      "--data",
      JSON.stringify({ account: SOL_MINT }),
    ],
    [
      "payment-links",
      "transactions",
      "build-sponsored-transaction",
      publicToken,
      "--data",
      JSON.stringify({ account: SOL_MINT, amount: "2" }),
    ],
    [
      "payment-links",
      "transactions",
      "build-sponsored-transaction",
      publicToken,
      "--account",
      SOL_MINT,
      "--idempotency-key",
      "unsupported",
    ],
    [
      "payment-links",
      "transactions",
      "build-sponsored-transaction",
      publicToken,
      "--account",
      SOL_MINT,
      "--private-key",
      "unsupported",
    ],
  ];
  for (const args of cases) {
    const result = await invoke(args, requestResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("invalid and foreign wallet creation errors preserve the server refusal without retries", async () => {
  for (const status of [400, 403, 404, 409, 422, 500]) {
    const result = await invoke(
      createArgs,
      Response.json(
        { error: { code: "REQUEST_REFUSED", message: "Request creation refused" }, meta },
        { status }
      )
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.requestId, meta.requestId);
    assert.equal(result.stdout, "");
  }
});

test("request cancellation preserves cancel attribution and server payment evidence in one explicit request", async () => {
  const data = {
    ...paymentRequest,
    status: "canceled",
    canceledByUserId: "usr_example",
    canceledAt: meta.timestamp,
    paidLate: false,
  };
  const result = await invoke(
    ["payment-requests", "cancel", "request/with space", "--idempotency-key", "cancel-42"],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0];
  assert.equal(
    request.url,
    "http://localhost:8787/v1/payments/requests/request%2Fwith%20space/cancel"
  );
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, undefined);
  assert.equal(new Headers(request.init.headers).get("idempotency-key"), "cancel-42");
  assert.deepEqual(JSON.parse(result.stdout).data, data);
});
