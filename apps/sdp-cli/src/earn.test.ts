import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EARN_PORTFOLIO_WALLET_STATUSES } from "@sdp/types/earn";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Command } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { earnCommands } from "./earn-commands";
import { runCli } from "./run";

const meta = { requestId: "req_earn", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "earn-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "earn-key", SDP_API_URL: session.SDP_API_URL };
const key = "11111111-1111-4111-8111-111111111111";
const amount = "9007199254740993.000001";
const allocations = { usdc: [{ yieldSourceId: "strategy_example", pct: 100 }] };
const deposit = {
  strategyId: "strategy_example",
  custodyWalletId: "cwlt_example",
  amount,
  minSharesOut: "24.980001",
};
const externalDeposit = {
  strategyId: "strategy_example",
  ownerAddress: SOL_MINT,
  amount,
  minSharesOut: "24.980001",
};
const withdrawal = {
  positionId: "position_example",
  shares: "25.000001",
  minAmountOut: "24.900001",
};
const queue = {
  positionId: withdrawal.positionId,
  shares: withdrawal.shares,
  discountBps: 0,
  deadlineSeconds: 60,
};
const submit = { transactionId: "transaction_example", signedTransaction: "AQIDBA==" };
const pathValues: Record<string, string> = {
  programId: "program/example",
  strategyId: "strategy/example",
  movementId: "legacy_movement_example",
  withdrawalRequestId: "request_example",
  withdrawalRef: "provider/ref with spaces",
};
const bodies: Record<string, JsonObject> = {
  cancelEarnVaultWithdrawalRequest: {},
  createEarnExternalWalletDeposit: submit,
  createEarnExternalWalletDepositTransaction: externalDeposit,
  createEarnExternalWalletQueuedWithdrawalPreview: queue,
  createEarnExternalWalletWithdrawal: submit,
  createEarnExternalWalletWithdrawalPreview: {
    positionId: withdrawal.positionId,
    shares: withdrawal.shares,
  },
  createEarnExternalWalletWithdrawalRequest: submit,
  createEarnExternalWalletWithdrawalRequestCancellation: submit,
  createEarnExternalWalletWithdrawalRequestCancelTransaction: {
    withdrawalRequestId: "request_example",
  },
  createEarnExternalWalletWithdrawalRequestTransaction: queue,
  createEarnExternalWalletWithdrawalTransaction: withdrawal,
  createEarnProgram: { provider: "veda", allocations },
  createEarnProgramWithdrawal: {
    amountUsd: "25.000001",
    token: "usdc",
    destinationAddress: SOL_MINT,
  },
  createEarnVaultDeposit: deposit,
  createEarnVaultDepositPreview: { strategyId: deposit.strategyId, amount },
  createEarnVaultQueuedWithdrawalPreview: queue,
  createEarnVaultWithdrawal: withdrawal,
  createEarnVaultWithdrawalPreview: {
    positionId: withdrawal.positionId,
    shares: withdrawal.shares,
  },
  createEarnVaultWithdrawalRequest: queue,
  getEarnExternalWalletWithdrawalOptions: { positionId: withdrawal.positionId },
  getEarnVaultWithdrawalOptions: { positionId: withdrawal.positionId },
  previewEarnProgramWithdrawal: { token: "usdc" },
  retargetEarnProgram: { allocations },
};
const strategy = {
  id: deposit.strategyId,
  name: "Fixture vault",
  provider: "kamino",
  providerReference: SOL_MINT,
  hostCluster: "devnet",
};
const depositResult = {
  positionId: withdrawal.positionId,
  movementId: "movement_example",
  status: "submitted",
  signature: "signature_fixture",
  failureReason: null,
  replayed: false,
  strategy,
};
const movement = {
  movementId: "movement_example",
  positionId: withdrawal.positionId,
  provider: "kamino",
  providerReference: SOL_MINT,
  direction: "withdrawal",
  status: "confirmed",
  settlement: "provider_order",
  signature: "signature_fixture",
  ownerAddress: SOL_MINT,
  amount,
  denomination: SOL_MINT,
  tokenMint: SOL_MINT,
  tokenAmount: null,
  failureReason: null,
  createdAt: meta.timestamp,
  confirmedAt: meta.timestamp,
  settledAt: null,
};
const build = {
  transactionId: submit.transactionId,
  transaction: "AQIDBA==",
  lastValidBlockHeight: "9007199254740993",
  sponsored: false,
  ownerAddress: SOL_MINT,
  provider: "kamino",
  providerReference: SOL_MINT,
  tokenMint: SOL_MINT,
  shareMint: SOL_MINT,
};
const request = {
  withdrawalRequestId: "request_example",
  positionId: withdrawal.positionId,
  provider: "veda",
  providerReference: SOL_MINT,
  ownerAddress: SOL_MINT,
  requestAddress: SOL_MINT,
  status: "closedOrUnknown",
  assetMint: SOL_MINT,
  shareMint: SOL_MINT,
  shares: withdrawal.shares,
  quotedAssets: "24.990001",
  shareDecimals: 6,
  assetDecimals: 6,
  nonce: "9007199254740993",
  creationTimestamp: "9007199254740993",
  creationSignature: "signature_fixture",
  cancelSignature: null,
  closingSignature: null,
  assetsPaid: null,
  failureReason: null,
  fulfilledAt: null,
  cancelledAt: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
  mechanism: "solverQueue",
  intermediateMint: null,
  intermediateAmount: null,
  discountBps: 0,
  maturityTimestamp: "9007199254740994",
  deadlineTimestamp: "9007199254740995",
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
function error(status = 403, code = "FORBIDDEN", message = "Earn operation refused.") {
  return Response.json({ error: { code, message }, meta }, { status });
}
function body(record: RecordedRequest) {
  return JSON.parse(String(record.init.body));
}
function argsFor(command: Command) {
  const operation = operationById(command.operationId);
  const args = [...command.words];
  for (const parameter of operation.parameters) {
    if (parameter.location === "path") {
      assert(pathValues[parameter.name]);
      args.push(pathValues[parameter.name]);
    }
    if (parameter.location === "query" && parameter.required) {
      assert.equal(parameter.name, "ownerAddress");
      args.push("--owner-address", SOL_MINT);
    }
    if (parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key")
      args.push("--idempotency-key", key);
  }
  if (operation.body !== null) {
    assert(bodies[command.operationId], command.operationId);
    args.push("--data", JSON.stringify(bodies[command.operationId]));
  }
  return args;
}

test("all 46 Earn commands provide offline scoped help and generated action/key requirements", async () => {
  assert.equal(earnCommands.length, 46);
  for (const args of [
    ["earn"],
    ["earn", "positions", "caller-signed"],
    ...earnCommands.map((command) => [...command.words, "--help"]),
  ]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args.includes("--help")) {
      assert(result.stdout.includes("Requires action: earn."));
      assert(result.stdout.includes("--project"));
    }
  }
});

test("every Earn operation is wired to one authenticated request with its exact path and body", async () => {
  for (const command of earnCommands) {
    const op = operationById(command.operationId);
    const result = await invoke(argsFor(command), error());
    assert.equal(result.code, 1, `${command.words.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 1);
    const record = result.requests[0];
    assert.equal(record.init.method, op.method);
    let expectedPath = op.path;
    for (const parameter of op.parameters.filter((p) => p.location === "path"))
      expectedPath = expectedPath.replace(
        `{${parameter.name}}`,
        encodeURIComponent(pathValues[parameter.name])
      );
    assert.equal(new URL(record.url).pathname, expectedPath);
    if (op.body === null) assert.equal(record.init.body, undefined);
    else assert.deepEqual(body(record), bodies[command.operationId]);
    assert.equal(new Headers(record.init.headers).get("authorization"), "Bearer earn-key");
    assert.equal(result.stdout, "");
  }
});

test("every Earn session command requires project selection before making a request", async () => {
  for (const command of earnCommands) {
    const result = await invoke(argsFor(command), error(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, `${command.operationId}: ${result.stderr}`);
    assert(result.stderr.includes("--project"));
    assert.equal(result.requests.length, 0);
  }
});

test("catalogue filters use their own pagination and preserve non-fundable strategy metadata", async () => {
  const fullStrategy = {
    ...strategy,
    sourceKind: "defi",
    depositMints: [SOL_MINT],
    apyType: "variable",
    liquidityTerm: "instant",
    status: "active",
    depositSlippage: null,
    withdrawalSlippage: null,
    fundable: false,
    feeSponsored: false,
    createdAt: meta.timestamp,
    updatedAt: meta.timestamp,
  };
  const data = { strategies: [fullStrategy], total: 1, page: 1, pageSize: 5 };
  const result = await invoke(
    [
      "earn",
      "strategies",
      "list",
      "--source-kind",
      "defi",
      "--apy-type",
      "variable",
      "--liquidity-term",
      "instant",
      "--cluster",
      "devnet",
      "--page",
      "1",
      "--page-size",
      "5",
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    sourceKind: "defi",
    apyType: "variable",
    liquidityTerm: "instant",
    cluster: "devnet",
    page: "1",
    pageSize: "5",
  });
});

test("movement history retains open provider IDs, model statuses, units, and opaque keyset cursors", async () => {
  const cursor = "opaque+/=:%?#&";
  const row = {
    id: "legacy_withdrawal_example",
    provider: "retired-provider",
    executionModel: "custodial",
    direction: "withdrawal",
    status: "pending_approval",
    positionId: withdrawal.positionId,
    denomination: "usd",
    amountRequested: amount,
    createdAt: meta.timestamp,
    updatedAt: meta.timestamp,
  };
  const data = { movements: [row], hasMore: true, nextCursor: cursor };
  const result = await invoke(
    [
      "earn",
      "treasury",
      "movements",
      "list",
      "--provider",
      row.provider,
      "--direction",
      "withdrawal",
      "--status",
      "pending_approval",
      "--position-id",
      withdrawal.positionId,
      "--source-address",
      "source_fixture",
      "--destination-address",
      SOL_MINT,
      "--before",
      cursor,
      "--limit",
      "100",
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(result.requests[0].url).searchParams), {
    provider: row.provider,
    direction: "withdrawal",
    status: "pending_approval",
    positionId: withdrawal.positionId,
    sourceAddress: "source_fixture",
    destinationAddress: SOL_MINT,
    before: cursor,
    limit: "100",
  });
});

test("vault recovery filters preserve false, caller keys and freshness bounds without adding defaults", async () => {
  const list = await invoke(
    ["earn", "deposits", "provider-signed", "list", "--request-id", key, "--settled", "false"],
    response({ deposits: [], hasMore: false, nextCursor: null })
  );
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(Object.fromEntries(new URL(list.requests[0].url).searchParams), {
    requestId: key,
    settled: "false",
  });
  const positions = await invoke(
    [
      "earn",
      "positions",
      "provider-signed",
      "list",
      "--after-movement-ids",
      "movement_one,movement_two",
    ],
    response({ positions: [], hasMore: false, nextCursor: null })
  );
  assert.equal(positions.code, 0, positions.stderr);
  assert.deepEqual(Object.fromEntries(new URL(positions.requests[0].url).searchParams), {
    afterMovementIds: "movement_one,movement_two",
  });
});

test("external summary stays address-free unless the caller explicitly requests owners and positions", async () => {
  const data = {
    summary: {
      walletCount: 0,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByStrategy: [],
      totalsByToken: [],
    },
  };
  for (const flags of [
    [],
    ["--include-owner-addresses", "false"],
    ["--include-owner-addresses", "true", "--include-positions", "true"],
  ]) {
    const result = await invoke(
      ["earn", "positions", "caller-signed", "project-summary", "get", ...flags],
      response(data)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    const query = new URL(result.requests[0].url).searchParams;
    assert.equal(query.get("includeOwnerAddresses"), flags[1] === undefined ? null : flags[1]);
    assert.equal(
      query.get("includePositions"),
      flags.includes("--include-positions") ? "true" : null
    );
  }
  const refused = await invoke(
    ["earn", "positions", "caller-signed", "project-summary", "get", "--include-positions", "true"],
    error(400, "BAD_REQUEST", "includePositions=true requires includeOwnerAddresses=true")
  );
  assert.equal(refused.code, 1);
  assert.equal(new URL(refused.requests[0].url).searchParams.get("includeOwnerAddresses"), null);
});

test("external reads require the owner only on routes whose contracts name it", async () => {
  for (const args of [
    ["earn", "positions", "caller-signed", "list"],
    ["earn", "movements", "caller-signed", "list"],
    ["earn", "earnings", "caller-signed", "get"],
    ["earn", "withdrawal-requests", "caller-signed", "list"],
  ]) {
    const result = await invoke(args, error());
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
  const detail = await invoke(
    ["earn", "movements", "caller-signed", "get", movement.movementId],
    response({ movement })
  );
  assert.equal(detail.code, 0, detail.stderr);
  assert.deepEqual(JSON.parse(detail.stdout).data, { movement });
  assert.equal(new URL(detail.requests[0].url).search, "");
});

test("program creation and retargeting keep allocations numeric and send one explicit key source", async () => {
  const program = {
    id: "program_example",
    provider: "veda",
    label: null,
    createdAt: meta.timestamp,
    wallet: {
      providerWalletRef: "provider_wallet_fixture",
      status: EARN_PORTFOLIO_WALLET_STATUSES[0],
      balance: { totalUsd: amount, withdrawableUsd: "0", reservedUsd: amount, earnedUsd: "0" },
      positions: [],
      allocations: {},
    },
  };
  for (const [args, expected, status] of [
    [
      [
        "earn",
        "portfolio-accounts",
        "create",
        "--provider",
        "veda",
        "--allocations",
        JSON.stringify(allocations),
        "--request-id",
        key,
      ],
      { provider: "veda", allocations, requestId: key },
      201,
    ],
    [
      [
        "earn",
        "portfolio-accounts",
        "allocation",
        "update",
        program.id,
        "--allocations",
        JSON.stringify(allocations),
        "--idempotency-key",
        key,
      ],
      { allocations },
      200,
    ],
  ] as const) {
    const result = await invoke([...args], response({ program }, status));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), expected);
    assert.deepEqual(JSON.parse(result.stdout).data.program, program);
    assert.equal(
      new Headers(result.requests[0].init.headers).get("idempotency-key"),
      args.includes("--idempotency-key") ? key : null
    );
  }
});

test("program withdrawal previews keep amount optional and leave liquidity answers unmodified", async () => {
  const data = {
    preview: { feeUsd: "0", withdrawableUsd: amount, totalUsdAfterWithdrawal: amount },
  };
  const result = await invoke(
    ["earn", "portfolio-accounts", "withdrawals", "preview", "program_example", "--asset", "usdc"],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { token: "usdc" });
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  const required = await invoke(
    [
      "earn",
      "portfolio-accounts",
      "withdrawals",
      "execute",
      "program_example",
      "--asset",
      "usdc",
      "--destination-address",
      SOL_MINT,
      "--idempotency-key",
      key,
    ],
    error()
  );
  assert.equal(required.code, 2);
  assert.equal(required.requests.length, 0);
});

test("custody deposit sends exact amounts and selected floors once with the required key", async () => {
  const args = [
    "earn",
    "deposits",
    "execute",
    "--strategy-id",
    deposit.strategyId,
    "--custody-wallet-id",
    deposit.custodyWalletId,
    "--amount",
    amount,
    "--min-shares-out",
    deposit.minSharesOut,
  ];
  const missing = await invoke(args, response(depositResult));
  assert.equal(missing.code, 2);
  assert.equal(missing.requests.length, 0);
  const result = await invoke([...args, "--idempotency-key", key], response(depositResult), {
    env: session,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), deposit);
  assert.equal(result.requests.length, 1);
  const headers = new Headers(result.requests[0].init.headers);
  assert.equal(headers.get("idempotency-key"), key);
  assert.equal(headers.get("x-project-id"), session.SDP_PROJECT_ID);
  assert.deepEqual(JSON.parse(result.stdout).data, depositResult);
});

test("previews preserve blocking issues without choosing a tolerance or executing a deposit", async () => {
  const data = {
    strategyId: deposit.strategyId,
    sharesOut: "24.980001",
    shareDecimals: 6,
    blockingIssues: [{ code: "CAP_EXCEEDED", message: "Deposit cap exceeded" }],
    feeSponsored: false,
  };
  const result = await invoke(
    ["earn", "deposits", "preview", "--strategy-id", deposit.strategyId, "--amount", amount],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(body(result.requests[0]), { strategyId: deposit.strategyId, amount });
});

test("external deposit builds return unsigned bytes and preserve large block heights without signing or submitting", async () => {
  const data = {
    transaction: {
      ...build,
      amount,
      minSharesOut: externalDeposit.minSharesOut,
      feePayer: SOL_MINT,
      strategy,
    },
  };
  const result = await invoke(
    [
      "earn",
      "deposits",
      "build-unsigned-transaction",
      "--data",
      JSON.stringify({
        ...externalDeposit,
        feePayer: SOL_MINT,
        sourceTokenMint: SOL_MINT,
        swapSlippageBps: 1,
      }),
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
  assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
  assert.equal(body(result.requests[0]).swapSlippageBps, 1);
});

test("split-swap builds preserve the advisory and follow-up without broadcasting or auto-building again", async () => {
  const data = {
    requiresSeparateSwap: true,
    sponsored: false,
    swap: {
      sourceTokenMint: SOL_MINT,
      sourceAmount: amount,
      depositAmount: "25.000001",
      quotedAmount: "25.100001",
      slippageBps: 0,
      priceImpactPct: "0.00001",
      routeLabels: [],
      transaction: "AQIDBA==",
      lastValidBlockHeight: build.lastValidBlockHeight,
    },
    followUp: {
      strategyId: deposit.strategyId,
      amount: "25.000001",
      minSharesOut: deposit.minSharesOut,
      feePayer: SOL_MINT,
    },
  };
  const result = await invoke(
    ["earn", "deposits", "build-unsigned-transaction", "--data", JSON.stringify(externalDeposit)],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
});

test("signed submission supports JSON, file and stdin and never changes the signed bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-earn-signed-"));
  try {
    const input = JSON.stringify(submit),
      filename = path.join(directory, "signed.json");
    await writeFile(filename, input);
    for (const source of [input, `@${filename}`, "-"]) {
      const result = await invoke(
        [
          "earn",
          "withdrawals",
          "submit-signed-transaction",
          "--data",
          source,
          "--idempotency-key",
          key,
        ],
        response({ withdrawal: movement }),
        { stdin: input }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), submit);
      assert.equal(result.requests.length, 1);
      assert.deepEqual(JSON.parse(result.stdout).data.withdrawal, movement);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("solver-queue and operator-redemption requests preserve distinct terms and explicit zero discounts", async () => {
  const cases = [
    { terms: queue, result: request },
    {
      terms: {
        positionId: withdrawal.positionId,
        shares: withdrawal.shares,
        mechanism: "operatorRedemption",
      },
      result: {
        ...request,
        provider: "hastra",
        mechanism: "operatorRedemption",
        intermediateMint: SOL_MINT,
        intermediateAmount: "25.000001",
        discountBps: null,
        maturityTimestamp: null,
        deadlineTimestamp: null,
      },
    },
    {
      terms: {
        positionId: withdrawal.positionId,
        intermediateAmount: "25.000001",
        mechanism: "operatorRedemption",
      },
      result: {
        ...request,
        provider: "hastra",
        mechanism: "operatorRedemption",
        shares: "0",
        intermediateMint: SOL_MINT,
        intermediateAmount: "25.000001",
        discountBps: null,
        maturityTimestamp: null,
        deadlineTimestamp: null,
      },
    },
  ];
  for (const entry of cases) {
    const result = await invoke(
      [
        "earn",
        "withdrawal-requests",
        "execute",
        "--data",
        JSON.stringify(entry.terms),
        "--idempotency-key",
        key,
      ],
      response({ withdrawalRequest: entry.result })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), entry.terms);
    assert.deepEqual(JSON.parse(result.stdout).data.withdrawalRequest, entry.result);
    assert.equal(result.requests.length, 1);
  }
  const flags = await invoke(
    [
      "earn",
      "withdrawal-requests",
      "execute",
      "--position-id",
      queue.positionId,
      "--shares",
      queue.shares,
      "--discount-bps",
      "0",
      "--deadline-seconds",
      "60",
      "--idempotency-key",
      key,
    ],
    response({ withdrawalRequest: request })
  );
  assert.equal(flags.code, 0, flags.stderr);
  assert.deepEqual(body(flags.requests[0]), queue);
});

test("custody cancellation sends an explicit empty body while request observations retain unknown payout state", async () => {
  const result = await invoke(
    [
      "earn",
      "withdrawal-requests",
      "cancel",
      "execute",
      request.withdrawalRequestId,
      "--idempotency-key",
      key,
    ],
    response({ withdrawalRequest: request })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {});
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout).data.withdrawalRequest, request);
});

test("external recovery builds and submits remain separate actions with the matching grants", async () => {
  assert.deepEqual(
    operationById("createEarnExternalWalletWithdrawalRequestCancelTransaction").authorization,
    { kind: "action", action: "earn.manage" }
  );
  assert.deepEqual(
    operationById("createEarnExternalWalletWithdrawalRequestCancellation").authorization,
    { kind: "action", action: "earn.execute" }
  );
  const data = {
    transaction: {
      ...build,
      positionId: withdrawal.positionId,
      withdrawalRequestId: request.withdrawalRequestId,
      action: "cancel",
      mechanism: "solverQueue",
      requestAddress: SOL_MINT,
    },
  };
  const result = await invoke(
    [
      "earn",
      "withdrawal-requests",
      "cancel",
      "build-unsigned-transaction",
      "--withdrawal-request-id",
      request.withdrawalRequestId,
      "--fee-payer",
      SOL_MINT,
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
});

test("invalid monetary, union, signature and allocation payloads fail before network access", async () => {
  for (const [words, payload] of [
    [["deposits", "execute"], { ...deposit, amount: 25 }],
    [["deposits", "execute"], { ...deposit, requestId: key }],
    [["withdrawals", "execute"], { ...withdrawal, requestId: key }],
    [["withdrawal-requests", "execute"], { ...queue, shares: undefined }],
    [["withdrawal-requests", "execute"], { ...queue, deadlineSeconds: 0 }],
    [["withdrawal-requests", "execute"], { ...queue, discountBps: -1 }],
    [["withdrawal-requests", "execute"], { ...queue, mechanism: "operatorRedemption" }],
    [
      ["withdrawal-requests", "execute"],
      {
        positionId: withdrawal.positionId,
        shares: "1",
        intermediateAmount: "1",
        mechanism: "operatorRedemption",
      },
    ],
    [["withdrawals", "submit-signed-transaction"], { ...submit, signedTransaction: "not base64!" }],
    [["withdrawals", "submit-signed-transaction"], { ...submit, requestId: key }],
  ] as const) {
    const result = await invoke(
      ["earn", ...words, "--data", JSON.stringify(payload), "--idempotency-key", key],
      error()
    );
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  const invalid = await invoke(
    [
      "earn",
      "portfolio-accounts",
      "create",
      "--provider",
      "veda",
      "--allocations",
      '{"usdc":[{"yieldSourceId":"strategy_example","pct":101}]}',
      "--idempotency-key",
      key,
    ],
    error()
  );
  assert.equal(invalid.code, 2);
  assert.equal(invalid.requests.length, 0);
});

test("read/build commands refuse retry keys, cross-family selectors and auto-execution flags", async () => {
  for (const args of [
    [
      "earn",
      "deposits",
      "build-unsigned-transaction",
      "--data",
      JSON.stringify(externalDeposit),
      "--idempotency-key",
      key,
    ],
    ["earn", "strategies", "list", "--provider", "kamino"],
    ["earn", "treasury", "movements", "list", "--page", "1"],
    ["earn", "portfolio-accounts", "get", "program_example", "--provider", "veda"],
    [
      "earn",
      "portfolio-accounts",
      "allocation",
      "update",
      "program_example",
      "--label",
      "Ignored label",
    ],
    ["earn", "deposits", "preview", "--custody-wallet-id", "cwlt_example"],
    ["earn", "withdrawals", "submit-signed-transaction", "--sign"],
  ]) {
    const result = await invoke(args, error());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});

test("feature, entitlement, capability, slippage, conflict and quota errors never start a fallback or retry", async () => {
  for (const [status, code, message] of [
    [403, "FORBIDDEN", "Earn is not enabled for this environment"],
    [403, "FORBIDDEN", "Provider is not entitled"],
    [400, "BAD_REQUEST", "minSharesOut must be supplied"],
    [409, "CONFLICT", "Key reused with different terms"],
    [429, "RATE_LIMITED", "Provider-read quota exceeded"],
    [501, "NOT_IMPLEMENTED", "Provider lacks this capability"],
    [503, "SERVICE_UNAVAILABLE", "Provider unavailable"],
  ] as const) {
    const result = await invoke(
      ["earn", "deposits", "execute", "--data", JSON.stringify(deposit), "--idempotency-key", key],
      error(status, code, message)
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code,
      message,
      status,
      requestId: meta.requestId,
    });
  }
  const network = await invoke(
    ["earn", "deposits", "execute", "--data", JSON.stringify(deposit), "--idempotency-key", key],
    response(depositResult),
    { failure: new TypeError("Connection lost") }
  );
  assert.equal(network.code, 1);
  assert.equal(network.requests.length, 1);
});

test("malformed Earn success responses cannot yield partial financial output", async () => {
  const { movementId: _movementId, ...missingMovementId } = depositResult;
  for (const payload of [
    missingMovementId,
    { ...depositResult, replayed: "false" },
    { ...depositResult, strategy: {} },
  ]) {
    const result = await invoke(
      ["earn", "deposits", "execute", "--data", JSON.stringify(deposit), "--idempotency-key", key],
      response(payload)
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
