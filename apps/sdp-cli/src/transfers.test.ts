import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PAYMENT_TRANSFER_STATUSES, PAYMENT_TRANSFER_TYPES } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_transfer", timestamp: "2026-01-01T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "transfer-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "transfer-key", SDP_API_URL: session.SDP_API_URL };
const amount = "9007199254740993.000000001";
const transfer = {
  id: "xfr_example",
  organizationId: "org_example",
  projectId: session.SDP_PROJECT_ID,
  custodyWalletId: "cwlt_source",
  providerWalletId: "provider_wallet_id",
  type: "transfer",
  kind: "pay",
  direction: "outbound",
  status: "processing",
  signature: null,
  serializedTx: null,
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  rampsMemo: {},
  source: SOL_MINT,
  destination: SOL_MINT,
  token: SOL_MINT,
  amount,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const recipients = [
  {
    counterpartyId: "cpty_one",
    counterpartyAccountId: "cpa_one",
    amount: "1.000000001",
    externalId: "row_one",
  },
  { counterpartyAccountId: "cpa_two", amount: "2.00" },
];
const batch = {
  id: "xbatch_example",
  organizationId: transfer.organizationId,
  projectId: session.SDP_PROJECT_ID,
  externalId: "payroll_42",
  sourceCustodyWalletId: "cwlt_source",
  sourceProviderWalletId: transfer.providerWalletId,
  sourceAddress: SOL_MINT,
  token: SOL_MINT,
  status: "processing",
  totalAmount: "3.000000001",
  recipientCount: 2,
  transactionCount: 1,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const estimate = {
  warnings: [],
  recipientCount: 2,
  transactionCount: 1,
  estimatedFees: {
    networkFeeLamports: "9007199254740993",
    priorityFeeLamports: "0",
    tokenAccountRentLamports: "2039280",
    sponsored: true,
  },
};
const createArgs = [
  "transfers",
  "execute",
  "--source-custody-wallet-id",
  "cwlt_source",
  "--destination",
  SOL_MINT,
  "--asset",
  "SOL",
  "--amount",
  amount,
];
const batchArgs = [
  "--source-custody-wallet-id",
  "cwlt_source",
  "--asset",
  "SOL",
  "--recipients",
  JSON.stringify(recipients),
];
const commands = [
  [...createArgs, "--idempotency-key", "transfer-1"],
  ["transfers", "list"],
  ["transfers", "get", transfer.id],
  ["transfer-batches", "estimate", ...batchArgs],
  [
    "transfer-batches",
    "execute",
    ...batchArgs,
    "--external-id",
    "payroll_42",
    "--idempotency-key",
    "batch-1",
  ],
  ["transfer-batches", "list"],
  ["transfer-batches", "get", batch.id],
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
function transferResponse() {
  return Response.json({ data: { transfer }, meta });
}
function batchResponse() {
  return Response.json({ data: { batch }, meta });
}
function requestBody(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function headers(request: RecordedRequest) {
  return new Headers(request.init.headers);
}

test("transfer and batch help works without credentials and identifies required retry keys", async () => {
  for (const args of [
    ["transfers"],
    ["transfer-batches"],
    ...commands.map((args) => [...args, "--help"]),
  ]) {
    const result = await invoke(args, transferResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[1] === "create") {
      assert(result.stdout.includes("Requires --idempotency-key"));
      assert(result.stdout.includes("--asset"));
    }
    if (args[1] === "estimate") assert(!result.stdout.includes("--idempotency-key"));
  }
});

test("all seven operations require a selected project for session calls", async () => {
  for (const args of commands) {
    const result = await invoke(args, transferResponse(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("transfer and batch grants and required headers come from their contracts", () => {
  for (const [id, action] of [
    ["createPaymentTransfer", "transfers.execute"],
    ["createPaymentTransferBatch", "transfer_batches.execute"],
    ["estimatePaymentTransferBatch", "transfer_batches.read"],
  ] as const) {
    const operation = operationById(id);
    assert.deepEqual(operation.authorization, { kind: "action", action });
    assert.equal(operation.sessionOnly, false);
    const idempotency = operation.parameters.find(
      (parameter) => parameter.name.toLowerCase() === "idempotency-key"
    );
    if (id === "estimatePaymentTransferBatch") assert.equal(idempotency, undefined);
    else assert.equal(idempotency?.required, true);
  }
});

test("transfer creation sends exact decimal strings and preserves a processing response", async () => {
  const result = await invoke(
    [...createArgs, "--memo", "Invoice 42", "--idempotency-key", "transfer-1"],
    transferResponse(),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/payments/transfers/execute");
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(requestBody(result.requests[0]), {
    sourceCustodyWalletId: "cwlt_source",
    destination: SOL_MINT,
    token: "SOL",
    amount,
    memo: "Invoice 42",
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), "transfer-1");
  assert.equal(headers(result.requests[0]).get("x-project-id"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: { transfer }, meta });
  assert.equal(result.requests.length, 1);
});

test("payment assets remain separate from explicit session credentials", async () => {
  const result = await invoke(
    [
      ...createArgs,
      "--token",
      "explicit-clerk-session",
      "--project",
      "prj_selected",
      "--idempotency-key",
      "transfer-1",
    ],
    transferResponse(),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(headers(result.requests[0]).get("authorization"), "Bearer explicit-clerk-session");
  assert.equal(headers(result.requests[0]).get("x-project-id"), "prj_selected");
  assert.equal(requestBody(result.requests[0]).token, "SOL");
  assert.equal(requestBody(result.requests[0]).projectId, undefined);
});

test("an existing off-ramp transfer ID is forwarded without creating a separate request", async () => {
  const result = await invoke(
    [...createArgs, "--transfer-id", "xfr_offramp", "--idempotency-key", "fund-offramp-1"],
    transferResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requestBody(result.requests[0]).transferId, "xfr_offramp");
  assert.equal(result.requests.length, 1);
});

test("create operations refuse a missing idempotency key before sending or generating one", async () => {
  for (const args of [
    createArgs,
    ["transfer-batches", "execute", ...batchArgs, "--external-id", "correlation-only"],
  ]) {
    const result = await invoke(args, transferResponse(), { env: apiKey });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Idempotency-Key"));
  }
});

test("JSON bodies from inline input, files and stdin retain their optional project and exact amounts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-transfer-"));
  try {
    for (const [args, body, response] of [
      [
        ["transfers", "execute"],
        {
          projectId: session.SDP_PROJECT_ID,
          sourceCustodyWalletId: "cwlt_source",
          destination: SOL_MINT,
          token: SOL_MINT,
          amount,
          memo: "",
        },
        transferResponse,
      ],
      [
        ["transfer-batches", "execute"],
        {
          projectId: session.SDP_PROJECT_ID,
          sourceCustodyWalletId: "cwlt_source",
          token: SOL_MINT,
          recipients,
          externalId: "payroll_42",
        },
        batchResponse,
      ],
    ] as const) {
      const text = JSON.stringify(body);
      const file = path.join(directory, "request.json");
      await writeFile(file, text);
      for (const source of [text, `@${file}`, "-"]) {
        const result = await invoke(
          [...args, "--data", source, "--idempotency-key", "request-1"],
          response(),
          { stdin: text }
        );
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(requestBody(result.requests[0]), body);
        assert.equal(result.requests.length, 1);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch estimation returns exact fees without a retry key or a create request", async () => {
  const result = await invoke(
    ["transfer-batches", "estimate", ...batchArgs],
    Response.json({ data: { estimate }, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/payments/transfer-batches/estimate"
  );
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(requestBody(result.requests[0]), {
    sourceCustodyWalletId: "cwlt_source",
    token: "SOL",
    recipients,
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: { estimate }, meta });
  assert.equal(result.requests.length, 1);
});

test("batch creation preserves recipient order, correlation IDs and false-valued options", async () => {
  const options = { maxRecipientsPerTransaction: 1, priorityFee: "none", preflight: false };
  const result = await invoke(
    [
      "transfer-batches",
      "execute",
      ...batchArgs,
      "--external-id",
      "payroll_42",
      "--options",
      JSON.stringify(options),
      "--idempotency-key",
      "batch-1",
    ],
    batchResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/payments/transfer-batches/execute"
  );
  assert.deepEqual(requestBody(result.requests[0]), {
    sourceCustodyWalletId: "cwlt_source",
    token: "SOL",
    externalId: "payroll_42",
    recipients,
    options,
  });
  assert.equal(headers(result.requests[0]).get("idempotency-key"), "batch-1");
  assert.equal(result.requests.length, 1);
});

test("batch output retains failed recipient rows, processing chunks and unavailable totals", async () => {
  const recipient = {
    id: "xrecipient_one",
    batchId: batch.id,
    transferId: null,
    externalId: null,
    counterpartyId: "cpty_one",
    counterpartyAccountId: "cpa_one",
    destination: SOL_MINT,
    amount: "1.00",
    status: "failed",
    error: "Account unavailable",
    createdAt: meta.timestamp,
    updatedAt: meta.timestamp,
  };
  const data = {
    batch: { ...batch, status: "partially_failed", totalAmount: null },
    recipients: [recipient],
    transfers: [{ ...transfer, type: "transfer_batch", kind: "batch_pay" }],
  };
  const result = await invoke(["transfer-batches", "get", batch.id], Response.json({ data, meta }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("detail requests encode SDP transfer and batch IDs as one URL segment", async () => {
  for (const [command, family, response] of [
    ["transfers", "transfers", transferResponse],
    ["transfer-batches", "transfer-batches", batchResponse],
  ] as const) {
    const result = await invoke([command, "get", "record/with?#"], response(), { env: apiKey });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.requests[0].url,
      `http://localhost:8787/v1/payments/${family}/record%2Fwith%3F%23`
    );
  }
});

test("transfer filters keep comma-separated sets, timestamps and observed-history selection", async () => {
  const pagination = { requestId: meta.requestId, total: 12, page: 2, pageSize: 5, hasMore: true };
  const statuses = PAYMENT_TRANSFER_STATUSES.join(",");
  const types = PAYMENT_TRANSFER_TYPES.join(",");
  const result = await invoke(
    [
      "transfers",
      "list",
      "--custody-wallet-id",
      "cwlt_exact",
      "--search",
      "Invoice & 42",
      "--asset",
      "SOL",
      "--direction",
      "outbound",
      "--status",
      statuses,
      "--type",
      types,
      "--counterparty-id",
      "cpty_one",
      "--provider",
      "moonpay",
      "--provider-reference",
      "Quote:example/42",
      "--from",
      "2026-01-01T02:00:00+02:00",
      "--to",
      "2026-01-02T00:00:00Z",
      "--include-observed",
      "true",
      "--sort-by",
      "amount",
      "--sort-direction",
      "asc",
      "--page",
      "2",
      "--page-size",
      "5",
    ],
    Response.json({ data: [transfer], meta: pagination }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    custodyWalletId: "cwlt_exact",
    search: "Invoice & 42",
    token: "SOL",
    direction: "outbound",
    status: statuses,
    type: types,
    counterpartyId: "cpty_one",
    provider: "moonpay",
    providerReference: "Quote:example/42",
    from: "2026-01-01T02:00:00+02:00",
    to: "2026-01-02T00:00:00Z",
    includeObserved: "true",
    sortBy: "amount",
    sortDirection: "asc",
    page: "2",
    pageSize: "5",
  });
  assert.deepEqual(JSON.parse(result.stdout), { data: [transfer], meta: pagination });
  assert.equal(result.requests.length, 1);
});

test("observed history stays opt-in and synthetic rows keep their nullable wallet identity", async () => {
  const observed = {
    ...transfer,
    custodyWalletId: null,
    status: "confirmed",
    signature: "observed_signature",
  };
  const data = [observed];
  const listMeta = { requestId: meta.requestId, total: 1, page: 1, pageSize: 20, hasMore: false };
  for (const args of [[], ["--include-observed", "false"]]) {
    const result = await invoke(
      ["transfers", "list", ...args],
      Response.json({ data, meta: listMeta })
    );
    assert.equal(result.code, 0, result.stderr);
    const query = new URL(result.requests[0].url).searchParams;
    assert.equal(query.get("includeObserved"), args.length === 0 ? null : "false");
    assert.equal(query.get("custodyWalletId"), null);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
  }
});

test("batch lists use source wallet, token, single status and correlation filters with pagination", async () => {
  const pagination = { requestId: meta.requestId, total: 8, page: 2, pageSize: 5, hasMore: false };
  const result = await invoke(
    [
      "transfer-batches",
      "list",
      "--source-custody-wallet-id",
      "cwlt_source",
      "--asset",
      SOL_MINT,
      "--status",
      "processing",
      "--external-id",
      "payroll_42",
      "--page",
      "2",
      "--page-size",
      "5",
    ],
    Response.json({ data: [batch], meta: pagination })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    sourceCustodyWalletId: "cwlt_source",
    token: SOL_MINT,
    status: "processing",
    externalId: "payroll_42",
    page: "2",
    pageSize: "5",
  });
  assert.deepEqual(JSON.parse(result.stdout), { data: [batch], meta: pagination });
  assert.equal(result.requests.length, 1);
});

test("explicit repetitions keep the caller's idempotency key and original payload", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await invoke(
      [...createArgs, "--idempotency-key", "same-logical-payment"],
      transferResponse()
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(headers(result.requests[0]).get("idempotency-key"), "same-logical-payment");
    assert.equal(requestBody(result.requests[0]).amount, amount);
    assert.equal(result.requests.length, 1);
  }
});

test("invalid transfer and batch arguments make no requests", async () => {
  const baseBody = { sourceCustodyWalletId: "cwlt_source", token: "SOL", recipients };
  const cases = [
    ["transfers", "execute", "--idempotency-key", "t-1"],
    [...createArgs, "--idempotency-key", "t-1", "--memo", "x".repeat(257)],
    [...createArgs, "--idempotency-key", "t-1", "--data", "{}"],
    [
      "transfers",
      "execute",
      "--idempotency-key",
      "t-1",
      "--data",
      JSON.stringify({
        sourceCustodyWalletId: "cwlt_source",
        destination: SOL_MINT,
        token: "SOL",
        amount: 1,
      }),
    ],
    [
      "transfers",
      "execute",
      "--idempotency-key",
      "t-1",
      "--data",
      JSON.stringify({
        sourceCustodyWalletId: "cwlt_source",
        destination: SOL_MINT,
        token: "SOL",
        amount: "1",
        sourceWalletId: "legacy_selector",
      }),
    ],
    ["transfers", "get"],
    ["transfers", "get", ".."],
    ["transfers", "list", "--page", "0"],
    ["transfers", "list", "--page-size", "101"],
    ["transfers", "list", "--search", "x".repeat(201)],
    ["transfers", "list", "--direction", "onramp"],
    ["transfers", "list", "--category", "invalid"],
    ["transfers", "list", "--sort-by", "invalid"],
    ["transfers", "list", "--sort-direction", "invalid"],
    ["transfers", "list", "--from", "invalid-time"],
    ["transfers", "list", "--include-observed", "invalid"],
    ["transfers", "list", "--provider", "privy"],
    ["transfer-batches", "estimate", ...batchArgs, "--idempotency-key", "unsupported"],
    ["transfer-batches", "estimate", "--recipients", "{}"],
    ["transfer-batches", "estimate", "--recipients", "[null]"],
    ["transfer-batches", "estimate", "--data", JSON.stringify({ ...baseBody, recipients: [] })],
    [
      "transfer-batches",
      "estimate",
      "--data",
      JSON.stringify({ ...baseBody, recipients: Array.from({ length: 501 }, () => recipients[0]) }),
    ],
    [
      "transfer-batches",
      "estimate",
      "--data",
      JSON.stringify({
        ...baseBody,
        recipients: [{ counterpartyAccountId: "cpa_one", amount: 1 }],
      }),
    ],
    ["transfer-batches", "estimate", ...batchArgs, "--options", "[]"],
    [
      "transfer-batches",
      "estimate",
      ...batchArgs,
      "--options",
      '{"maxRecipientsPerTransaction":65}',
    ],
    ["transfer-batches", "estimate", ...batchArgs, "--options", '{"priorityFee":"invalid"}'],
    ["transfer-batches", "estimate", ...batchArgs, "--options", '{"preflight":"false"}'],
    ["transfer-batches", "list", "--status", "confirmed,failed"],
    ["transfer-batches", "get", ".."],
  ];
  for (const args of cases) {
    const result = await invoke(args, transferResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("refusals and ambiguous failures never trigger another submission or change the retry key", async () => {
  for (const args of [
    [...createArgs, "--idempotency-key", "same-key"],
    [
      "transfer-batches",
      "execute",
      ...batchArgs,
      "--external-id",
      "payroll_42",
      "--idempotency-key",
      "same-key",
    ],
  ]) {
    for (const [status, code] of [
      [400, "BAD_REQUEST"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "IDEMPOTENCY_KEY_IN_FLIGHT"],
      [422, "IDEMPOTENCY_KEY_REUSED"],
      [429, "RATE_LIMITED"],
      [500, "INTERNAL_ERROR"],
      [503, "PROVIDER_UNAVAILABLE"],
    ] as const) {
      const result = await invoke(
        args,
        Response.json({ error: { code, message: "Transfer request refused" }, meta }, { status })
      );
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.requests.length, 1);
      assert.equal(headers(result.requests[0]).get("idempotency-key"), "same-key");
      assert.equal(JSON.parse(result.stderr).error.code, code);
      assert.equal(JSON.parse(result.stderr).error.status, status);
      assert.equal(result.stdout, "");
    }
    const timedOut = await invoke(args, transferResponse(), {
      failure: new DOMException("private provider details", "TimeoutError"),
    });
    assert.equal(timedOut.code, 1);
    assert.equal(timedOut.requests.length, 1);
    assert.equal(JSON.parse(timedOut.stderr).error.code, "TIMEOUT");
    assert(!timedOut.stderr.includes("private provider"));
  }
});

test("unresolved Fireblocks approval and nullable submission evidence are preserved", async () => {
  const data = {
    transfer: {
      ...transfer,
      fireblocks: { transactionId: null, status: "SUBMISSION_UNKNOWN", subStatus: null },
    },
  };
  const result = await invoke(["transfers", "get", transfer.id], Response.json({ data, meta }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
  assert.equal(result.requests.length, 1);
});

test("malformed transfer, batch and fee responses fail before emitting partial data", async () => {
  for (const [args, data] of [
    [[...createArgs, "--idempotency-key", "transfer-1"], { transfer: { id: transfer.id } }],
    [["transfer-batches", "get", batch.id], { batch: { id: batch.id } }],
    [
      ["transfer-batches", "estimate", ...batchArgs],
      {
        estimate: {
          ...estimate,
          estimatedFees: { ...estimate.estimatedFees, networkFeeLamports: 5000 },
        },
      },
    ],
  ] as const) {
    const result = await invoke([...args], Response.json({ data, meta }));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 1);
  }
});

test("batch retries explicitly resend only the server-selected failed recipients with a caller key", async () => {
  const args = [
    "transfer-batches",
    "retry",
    "batch/with space",
    "--idempotency-key",
    "retry-intent-42",
  ];
  const result = await invoke(args, batchResponse());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/payments/transfer-batches/batch%2Fwith%20space/retry"
  );
  assert.equal(result.requests[0].init.method, "POST");
  assert.equal(result.requests[0].init.body, undefined);
  assert.equal(headers(result.requests[0]).get("idempotency-key"), "retry-intent-42");
  const conflict = await invoke(
    args,
    Response.json(
      { error: { code: "TRANSFER_BATCH_NOTHING_TO_RETRY", message: "No failed recipients" }, meta },
      { status: 409 }
    )
  );
  assert.equal(conflict.code, 1);
  assert.equal(conflict.requests.length, 1);
  assert.equal(conflict.stdout, "");
  assert.equal(JSON.parse(conflict.stderr).error.code, "TRANSFER_BATCH_NOTHING_TO_RETRY");
  for (const extra of [[], ["--idempotency-key", "retry-intent-42", "--data", "{}"]]) {
    const invalid = await invoke(
      ["transfer-batches", "retry", batch.id, ...extra],
      batchResponse()
    );
    assert.equal(invalid.code, 2);
    assert.equal(invalid.requests.length, 0);
  }
});

test("batch execution requires an explicit external ID", async () => {
  const missing = await invoke(
    ["transfer-batches", "execute", ...batchArgs, "--idempotency-key", "batch-42"],
    batchResponse()
  );
  assert.equal(missing.code, 2);
  assert.equal(missing.requests.length, 0);
  assert(missing.stderr.includes("externalId"));
});
