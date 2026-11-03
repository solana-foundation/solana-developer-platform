import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DVP_CLOSE_REFUSAL } from "@sdp/types/dvp";
import { NETWORK_METRIC_IDS } from "@sdp/types/network-metrics";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { runCli } from "./run";

async function listen(listener: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    })
  );
}

async function invoke(
  apiUrl: string,
  args: string[],
  env: NodeJS.ProcessEnv = { SDP_API_KEY: "local-test-key" }
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    env: { ...env, SDP_API_URL: apiUrl },
    fetcher: fetch,
    readStdin: async () => "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

test("native HTTP transport sends the project query and auth header", async () => {
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.url, "/v1/projects?includeArchived=true");
    assert.equal(request.headers.authorization, "Bearer local-test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: { projects: [] },
        meta: { requestId: "req_http", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(url, ["projects", "list", "--include-archived"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).meta.requestId, "req_http");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP transport refuses redirects without following them", async () => {
  let requests = 0;
  const { server, url } = await listen((_request, response) => {
    requests += 1;
    response.writeHead(302, { location: "/redirected" });
    response.end();
  });
  try {
    const result = await invoke(url, ["projects", "list"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "NETWORK_ERROR");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("the timeout also cancels a response whose JSON body never completes", async () => {
  const { server, url } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
  });
  try {
    const result = await invoke(url, ["projects", "list", "--timeout-ms", "100"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "TIMEOUT");
    assert.equal(result.stdout, "");
  } finally {
    await close(server);
  }
});

test("native HTTP transport handles self-service organization leave with an empty 204 response", async () => {
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, "/v1/members/me");
    assert.equal(request.headers.authorization, "Bearer local-test-session");
    assert.equal(request.headers["content-type"], undefined);
    response.writeHead(204);
    response.end();
  });
  try {
    const result = await invoke(url, ["members", "leave-organization"], {
      SDP_TOKEN: "local-test-session",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP invitation creation sends the project, role, and retry key once", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/members/invitations");
    assert.equal(request.headers["x-project-id"], "prj_fixture");
    assert.equal(request.headers["idempotency-key"], "invite-fixture-1");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { email: "invitee@example.com", role: "viewer" });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          invitation: {
            id: "inv_fixture",
            email: "invitee@example.com",
            role: "viewer",
            expiresAt: "2026-01-08T00:00:00.000Z",
          },
        },
        meta: { requestId: "req_invite", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(
      url,
      [
        "invitations",
        "create",
        "--email",
        "invitee@example.com",
        "--role",
        "viewer",
        "--idempotency-key",
        "invite-fixture-1",
      ],
      { SDP_TOKEN: "local-test-session", SDP_PROJECT_ID: "prj_fixture" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.invitation.id, "inv_fixture");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP key revocation sends its JSON confirmation and preserves cancellation results", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, "/v1/api-keys/key_fixture");
    assert.equal(request.headers["x-project-id"], "prj_fixture");
    assert.equal(request.headers["idempotency-key"], undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      confirmation: "Service Key",
      cancelRecurringPayments: true,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          success: true,
          revokedAt: "2026-01-01T00:00:00.000Z",
          recurringPayments: { canceled: ["rec_one"], failed: ["rec_two"] },
        },
        meta: { requestId: "req_revoke", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(
      url,
      [
        "api-keys",
        "revoke",
        "key_fixture",
        "--confirmation",
        "Service Key",
        "--cancel-recurring-payments",
      ],
      { SDP_TOKEN: "local-test-session", SDP_PROJECT_ID: "prj_fixture" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data.recurringPayments, {
      canceled: ["rec_one"],
      failed: ["rec_two"],
    });
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP wallet deletion sends the provider ID and optional idempotency key in one request", async () => {
  let requests = 0;
  const walletId = "provider/wallet?#";
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "DELETE");
    assert.equal(request.url, "/v1/wallets");
    assert.equal(request.headers["x-project-id"], "prj_fixture");
    assert.equal(request.headers["idempotency-key"], "wallet-delete-1");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { walletId, provider: "privy" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: { walletId, deleted: true },
        meta: { requestId: "req_wallet_delete", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(
      url,
      [
        "wallets",
        "delete",
        "--wallet-id",
        walletId,
        "--provider",
        "privy",
        "--idempotency-key",
        "wallet-delete-1",
      ],
      { SDP_TOKEN: "local-test-session", SDP_PROJECT_ID: "prj_fixture" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.deleted, true);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP account updates encode both IDs and send a null label without extra requests", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/v1/counterparties/parent%2Fid%3F%23/accounts/account%2Fid%3F%23");
    assert.equal(request.headers["x-project-id"], "prj_fixture");
    assert.equal(request.headers["idempotency-key"], "account-update-1");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { label: null, providerAccountData: {} });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          account: {
            id: "account/id?#",
            counterpartyId: "parent/id?#",
            organizationId: "org_fixture",
            projectId: "prj_fixture",
            accountKind: "crypto_wallet",
            label: null,
            details: { network: "solana", address: SOL_MINT },
            providerAccountData: {},
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        meta: { requestId: "req_account_update", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(
      url,
      [
        "counterparties",
        "accounts",
        "update",
        "parent/id?#",
        "account/id?#",
        "--clear-label",
        "--provider-account-data",
        "{}",
        "--idempotency-key",
        "account-update-1",
      ],
      { SDP_TOKEN: "local-test-session", SDP_PROJECT_ID: "prj_fixture" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.account.label, null);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP batch creation requires the supplied key and sends exact recipient amounts once", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/payments/transfer-batches/execute");
    assert.equal(request.headers["idempotency-key"], "batch-fixture-1");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      externalId: "payroll_fixture",
      sourceCustodyWalletId: "cwlt_fixture",
      token: "SOL",
      recipients: [{ counterpartyAccountId: "cpa_fixture", amount: "1.000000001" }],
      options: { preflight: false },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          batch: {
            id: "xbatch_fixture",
            organizationId: "org_fixture",
            projectId: "prj_fixture",
            externalId: null,
            sourceCustodyWalletId: "cwlt_fixture",
            sourceProviderWalletId: "provider_fixture",
            sourceAddress: SOL_MINT,
            token: SOL_MINT,
            status: "processing",
            totalAmount: "1.000000001",
            recipientCount: 1,
            transactionCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        meta: { requestId: "req_batch", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  const args = [
    "transfer-batches",
    "execute",
    "--external-id",
    "payroll_fixture",
    "--source-custody-wallet-id",
    "cwlt_fixture",
    "--asset",
    "SOL",
    "--recipients",
    '[{"counterpartyAccountId":"cpa_fixture","amount":"1.000000001"}]',
    "--options",
    '{"preflight":false}',
  ];
  try {
    const missing = await invoke(url, args);
    assert.equal(missing.code, 2);
    assert.equal(requests, 0);
    const created = await invoke(url, [...args, "--idempotency-key", "batch-fixture-1"]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).data.batch.status, "processing");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP payment links prepare a payer transaction without account credentials or an envelope", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/pay/link%2Ffixture%3F%23/tx");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-project-id"], undefined);
    assert.equal(request.headers["idempotency-key"], undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { account: SOL_MINT });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ transaction: "AQIDBA==", message: "Pay fixture" }));
  });
  try {
    const result = await invoke(
      url,
      [
        "payment-links",
        "transactions",
        "build-sponsored-transaction",
        "link/fixture?#",
        "--account",
        SOL_MINT,
      ],
      {
        SDP_API_KEY: "ignored-api-key",
        SDP_TOKEN: "ignored-session",
        SDP_PROJECT_ID: "prj_ignored",
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      transaction: "AQIDBA==",
      message: "Pay fixture",
    });
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP recurring cancellation requires the same explicit key and never retries a conflict", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/payments/recurring-payments/prp_fixture/cancel");
    assert.equal(request.headers["idempotency-key"], "cancel-fixture-1");
    assert.equal(request.headers["content-type"], undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(body, "");
    response.writeHead(409, { "content-type": "application/json", "retry-after": "30" });
    response.end(
      JSON.stringify({
        error: { code: "IDEMPOTENCY_KEY_IN_FLIGHT", message: "Cancellation is processing" },
        meta: { requestId: "req_cancel" },
      })
    );
  });
  try {
    const args = ["recurring-payments", "cancel", "prp_fixture"];
    const missing = await invoke(url, args);
    assert.equal(missing.code, 2);
    assert.equal(requests, 0);
    const result = await invoke(url, [...args, "--idempotency-key", "cancel-fixture-1"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "IDEMPOTENCY_KEY_IN_FLIGHT");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native HTTP subscription preparation sends integer-string consent values without submission", async () => {
  let requests = 0;
  const { server, url } = await listen(async (request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      "/v1/payments/subscriptions/psub_fixture/authorize/build-unsigned-transaction"
    );
    assert.equal(request.headers["x-project-id"], "prj_fixture");
    assert.equal(request.headers["idempotency-key"], undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      subscriberTokenAccount: SOL_MINT,
      expectedPlanCreatedAt: "18446744073709551615",
      expectedSubscriptionAuthorityInitId: "-9223372036854775808",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          subscription: {
            id: "psub_fixture",
            organizationId: "org_fixture",
            projectId: "prj_fixture",
            planId: "psp_fixture",
            counterpartyId: "cpty_fixture",
            subscriberAddress: SOL_MINT,
            subscriberTokenAccount: SOL_MINT,
            subscriptionPda: SOL_MINT,
            subscriptionAuthorityAddress: SOL_MINT,
            authorizationSignature: null,
            status: "pending_authorization",
            currentPeriodStartAt: null,
            nextCollectionDueAt: null,
            cancelAt: null,
            canceledAt: null,
            createdBy: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          subscriptionPda: SOL_MINT,
          subscriptionAuthorityAddress: SOL_MINT,
          preparedTransaction: {
            serialized: "AQIDBA==",
            blockhash: "blockhash_fixture",
            lastValidBlockHeight: "9007199254740993",
            requiredSigners: [SOL_MINT],
          },
        },
        meta: { requestId: "req_authorization", timestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
  });
  try {
    const result = await invoke(
      url,
      [
        "subscriptions",
        "authorize",
        "build-unsigned-transaction",
        "psub_fixture",
        "--subscriber-token-account",
        SOL_MINT,
        "--expected-plan-created-at",
        "18446744073709551615",
        "--expected-subscription-authority-init-id=-9223372036854775808",
      ],
      { SDP_TOKEN: "local-test-session", SDP_PROJECT_ID: "prj_fixture" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).data.preparedTransaction.lastValidBlockHeight,
      "9007199254740993"
    );
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native ramp checkout transport sends scoped JSON once and returns widget credentials", async () => {
  let requests = 0;
  const payload = {
    provider: "stripe",
    counterpartyId: "cpty_example",
    destinationCustodyWalletId: "cwlt_destination",
    assetRail: "usdc.solana",
    fiatCurrency: "USD",
    fiatAmount: "100.000001",
    rampsMemo: { order: "00042" },
  };
  const envelope = {
    data: {
      quote: {
        id: "quote_native",
        provider: "stripe",
        status: "pending",
        deliveryMode: "session_widget",
        clientSecret: "native_widget_secret",
        sessionId: "session_fixture",
        publishableKey: "pk_fixture",
      },
      transferId: "xfr_native",
    },
    meta: { requestId: "req_native_ramp", timestamp: "2026-01-01T00:00:00.000Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/payments/ramps/onramp/start");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["idempotency-key"], undefined);
    let input = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      input += chunk;
    });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(input), payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
    });
  });
  try {
    const result = await invoke(url, ["onramps", "start", "--data", JSON.stringify(payload)], {
      SDP_TOKEN: "local-session",
      SDP_PROJECT_ID: "prj_example",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native history transport encodes the cursor and filter timestamps in one scoped GET", async () => {
  let requests = 0;
  const cursor = "opaque+/=:%?#&λ";
  const envelope = {
    data: {
      transactions: [
        {
          id: "earn:movement_example",
          module: "earn",
          moduleId: "movement_example",
          kind: "withdraw",
          status: "pending",
          moduleStatus: "requested",
          organizationId: "org_example",
          projectId: "prj_example",
          custodyWalletId: "cwlt_example",
          custodyWalletLabel: null,
          token: null,
          amount: null,
          counterpartyId: null,
          signature: null,
          createdAt: "2026-10-29T00:00:00Z",
        },
      ],
      nextCursor: "next_page_fixture",
    },
    meta: { requestId: "req_native_history", timestamp: "2026-10-29T00:00:00Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert(request.url);
    const requestUrl = new URL(request.url, "http://localhost");
    assert.equal(requestUrl.pathname, "/v1/transactions");
    assert.deepEqual(Object.fromEntries(requestUrl.searchParams), {
      module: "earn",
      kind: "withdraw",
      token: SOL_MINT,
      createdAtFrom: "2026-10-01T00:00:00Z",
      cursor,
      limit: "25",
    });
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], undefined);
    assert.equal(request.headers["content-type"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
  try {
    const result = await invoke(
      url,
      [
        "transactions",
        "list",
        "--module",
        "earn",
        "--kind",
        "withdraw",
        "--asset",
        SOL_MINT,
        "--from",
        "2026-10-01T00:00:00Z",
        "--cursor",
        cursor,
        "--limit",
        "25",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Earn submit sends the caller's signed bytes and key once without inferring settlement", async () => {
  let requests = 0;
  const payload = { transactionId: "transaction_fixture", signedTransaction: "AQIDBA==" };
  const envelope = {
    data: {
      withdrawal: {
        movementId: "movement_fixture",
        positionId: "position_fixture",
        provider: "veda",
        providerReference: SOL_MINT,
        direction: "withdrawal",
        status: "confirmed",
        settlement: "provider_order",
        signature: "signature_fixture",
        ownerAddress: SOL_MINT,
        amount: "9007199254740993.000001",
        denomination: SOL_MINT,
        tokenMint: SOL_MINT,
        tokenAmount: null,
        failureReason: null,
        createdAt: "2026-10-29T00:00:00Z",
        confirmedAt: "2026-10-29T00:00:00Z",
        settledAt: null,
      },
    },
    meta: { requestId: "req_native_earn", timestamp: "2026-10-29T00:00:00Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/earn/withdrawals/submit-signed-transaction");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], "11111111-1111-4111-8111-111111111111");
    let input = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      input += chunk;
    });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(input), payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
    });
  });
  try {
    const result = await invoke(
      url,
      [
        "earn",
        "withdrawals",
        "submit-signed-transaction",
        "--data",
        JSON.stringify(payload),
        "--idempotency-key",
        "11111111-1111-4111-8111-111111111111",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native DvP funding sends only the selected leg and SDP wallet with its explicit key", async () => {
  let requests = 0;
  const data = {
    tradeId: "dvp_example",
    leg: "b",
    amount: "18446744073709551615",
    signature: "signature_fixture",
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/dvp/trades/dvp_example/fund");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], "fund-42");
    let input = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      input += chunk;
    });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(input), { side: "b", walletId: "cwlt_b" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data,
          meta: { requestId: "req_native_dvp", timestamp: "2026-10-29T00:00:00Z" },
        })
      );
    });
  });
  try {
    const result = await invoke(
      url,
      [
        "dvp",
        "trades",
        "fund",
        "dvp_example",
        "--side",
        "b",
        "--custody-wallet-id",
        "cwlt_b",
        "--idempotency-key",
        "fund-42",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native DvP close preserves structured refusal details and the request header without retry", async () => {
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/dvp/trades/dvp_example/settle");
    assert.equal(request.headers["content-type"], undefined);
    assert.equal(request.headers["idempotency-key"], "settle-42");
    response.writeHead(409, {
      "content-type": "application/json",
      "x-request-id": "req_native_close",
    });
    response.end(
      JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "A leg is moving",
          details: { reason: DVP_CLOSE_REFUSAL.legMoving },
        },
        meta: {},
      })
    );
  });
  try {
    const result = await invoke(url, [
      "dvp",
      "trades",
      "settle",
      "dvp_example",
      "--idempotency-key",
      "settle-42",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(requests, 1);
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code: "CONFLICT",
      message: "A leg is moving",
      status: 409,
      requestId: "req_native_close",
      details: { reason: DVP_CLOSE_REFUSAL.legMoving },
    });
  } finally {
    await close(server);
  }
});

test("native public token metadata never receives configured account credentials or tenant headers", async () => {
  let requests = 0;
  const metadata = {
    name: "Fixture token",
    symbol: "FIX",
    asset: { name: "Public asset" },
    chain: { decimals: 0 },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/issuance/tokens/public%2Ftoken%3F%23/metadata.json");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-project-id"], undefined);
    assert.equal(request.headers["content-type"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(metadata));
  });
  try {
    const result = await invoke(url, ["issuance", "tokens", "metadata", "get", "public/token?#"], {
      SDP_API_KEY: "ignored-key",
      SDP_TOKEN: "ignored-session",
      SDP_PROJECT_ID: "ignored-project",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), metadata);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native issuance history preserves repeated query types and one scoped page", async () => {
  let requests = 0;
  const envelope = {
    data: [],
    meta: { total: 0, page: 1, pageSize: 50, hasMore: false, requestId: "req_native_issuance" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert(request.url);
    const parsed = new URL(request.url, "http://localhost");
    assert.equal(parsed.pathname, "/v1/issuance/transactions");
    assert.deepEqual(parsed.searchParams.getAll("type"), ["burn", "force_burn"]);
    assert.equal(parsed.searchParams.get("custodyWalletId"), "cwlt_example");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
  try {
    const result = await invoke(
      url,
      [
        "issuance",
        "transactions",
        "list",
        "--type",
        "burn",
        "--type",
        "force_burn",
        "--custody-wallet-id",
        "cwlt_example",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Private Channels deposit preserves the explicit retry key and exact decimal body", async () => {
  let requests = 0;
  let received = "";
  const envelope = {
    error: {
      code: "CONFLICT",
      message: "Recorded intent differs",
      details: { reason: "idempotency_mismatch" },
    },
    meta: { requestId: "req_native_private" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/private-channels/deposits");
    assert.equal(request.headers.authorization, "Bearer local-test-key");
    assert.equal(request.headers["idempotency-key"], "original-intent-42");
    assert.equal(request.headers["x-project-id"], undefined);
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
    });
  });
  try {
    const result = await invoke(url, [
      "private-channels",
      "deposits",
      "execute",
      "--wallet-id",
      "cwlt_example",
      "--amount",
      "9007199254740993.000001",
      "--mint",
      SOL_MINT,
      "--recipient",
      SOL_MINT,
      "--idempotency-key",
      "original-intent-42",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(JSON.parse(received), {
      walletId: "cwlt_example",
      amount: "9007199254740993.000001",
      mint: SOL_MINT,
      recipient: SOL_MINT,
    });
    assert.deepEqual(JSON.parse(result.stderr).error.details, envelope.error.details);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Private Channels membership encodes both resource IDs and uses session scope", async () => {
  let requests = 0;
  const envelope = {
    data: { removed: true },
    meta: { requestId: "req_native_membership", timestamp: "2026-10-29T00:00:00.000Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "DELETE");
    assert.equal(
      request.url,
      "/v1/private-channels/channels/channel%2Fexample%3F%23/principal-memberships/principal%2Fexample%3F%23"
    );
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
  try {
    const result = await invoke(
      url,
      [
        "private-channels",
        "channels",
        "principal-memberships",
        "remove",
        "channel/example?#",
        "principal/example?#",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Rings creation sends exact base units and nonce once without an idempotency header", async () => {
  let requests = 0,
    received = "";
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/helius-rings/operations/execute");
    assert.equal(request.headers.authorization, "Bearer local-test-key");
    assert.equal(request.headers["idempotency-key"], undefined);
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Upstream uncertain",
            details: { reason: "gateway_unavailable" },
          },
          meta: { requestId: "req_native_rings" },
        })
      );
    });
  });
  try {
    const result = await invoke(url, [
      "helius-rings",
      "operations",
      "execute",
      "--rings-wallet-id",
      "hrw_example",
      "--op-type",
      "shield",
      "--mint",
      SOL_MINT,
      "--amount-raw",
      "18446744073709551615",
      "--client-nonce",
      "original-nonce-42",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(JSON.parse(received), {
      walletId: "hrw_example",
      opType: "shield",
      asset: { mint: SOL_MINT, amountRaw: "18446744073709551615" },
      clientNonce: "original-nonce-42",
    });
    assert.equal(JSON.parse(result.stderr).error.details.reason, "gateway_unavailable");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Rings connection administration reaches the internal path with an administrator session", async () => {
  let requests = 0;
  const envelope = {
    data: { health: { rpc: "green", prover: "green", photon: "amber" }, ringRpc: null },
    meta: { requestId: "req_native_connection", timestamp: "2026-10-29T00:00:00.000Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(
      request.url,
      "/internal/dashboard/helius-rings/connections/connection%2Fexample%3F%23/test"
    );
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["content-type"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
  try {
    const result = await invoke(
      url,
      ["helius-rings", "connections", "test", "connection/example?#"],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native compliance screening sends the optional key once and preserves partial provider results", async () => {
  let requests = 0,
    received = "";
  const timestamp = "2026-10-29T00:00:00.000Z";
  const envelope = {
    data: {
      screening: {
        address: SOL_MINT,
        network: "solana",
        intent: "transfer_destination",
        checkedAt: timestamp,
        providers: [
          { provider: "range", status: "ok", riskScore: 0, evaluatedAt: timestamp },
          {
            provider: "chainalysis",
            status: "pending",
            riskScore: null,
            providerStatus: "PENDING",
            evaluatedAt: timestamp,
          },
        ],
      },
    },
    meta: { requestId: "req_native_compliance", timestamp },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/compliance/address-screenings");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], "screening-42");
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "application/json",
        "Idempotent-Replayed": "true",
      });
      response.end(JSON.stringify(envelope));
    });
  });
  try {
    const result = await invoke(
      url,
      [
        "compliance",
        "screen-address",
        "--address",
        SOL_MINT,
        "--intent",
        "transfer_destination",
        "--idempotency-key",
        "screening-42",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(received), { address: SOL_MINT, intent: "transfer_destination" });
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native Places autocomplete and details share only the caller's explicit lookup session", async () => {
  let requests = 0;
  const token = "lookup/+?=#",
    account = { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "unused-project" };
  const meta = { requestId: "req_native_places", timestamp: "2026-10-29T00:00:00.000Z" };
  const place = {
    placeId: "place/example?#",
    formattedAddress: "Fixture address",
    location: { latitude: 0, longitude: 0 },
    addressFields: {
      line1: "Fixture street",
      line2: "",
      city: "",
      postalCode: "00001",
      countryCode: "US",
      subdivisionCode: "",
    },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], undefined);
    if (request.method === "POST") {
      assert.equal(request.url, "/v1/places/autocomplete");
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        assert.deepEqual(JSON.parse(raw), { input: "Fixture street", sessionToken: token });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: { suggestions: [{ placeId: place.placeId, mainText: "Fixture street" }] },
            meta,
          })
        );
      });
    } else {
      assert(request.url);
      const parsed = new URL(request.url, "http://localhost");
      assert.equal(parsed.pathname, "/v1/places/place%2Fexample%3F%23");
      assert.equal(parsed.searchParams.get("sessionToken"), token);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { place }, meta }));
    }
  });
  try {
    const autocomplete = await invoke(
      url,
      ["places", "autocomplete", "--input", "Fixture street", "--session-token", token],
      account
    );
    assert.equal(autocomplete.code, 0, autocomplete.stderr);
    assert.equal(requests, 1);
    const details = await invoke(
      url,
      ["places", "details", "get", place.placeId, "--session-token", token],
      account
    );
    assert.equal(details.code, 0, details.stderr);
    assert.deepEqual(JSON.parse(details.stdout).data.place, place);
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});

test("native static-map transport saves the exact PNG and keeps stdout JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-native-map-"));
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z2sAAAAASUVORK5CYII=",
      "base64"
    )
  );
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.url, "/v1/places/static-map?latitude=0&longitude=0");
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer local-test-key");
    assert.equal(request.headers["x-project-id"], undefined);
    assert(request.headers.accept?.includes("image/png"));
    response.writeHead(200, { "content-type": "image/png" });
    response.end(png);
  });
  try {
    const output = path.join(directory, "map.png"),
      result = await invoke(url, [
        "places",
        "static-map",
        "download",
        "--latitude",
        "0",
        "--longitude",
        "0",
        "--output",
        output,
      ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(output), Buffer.from(png));
    assert.deepEqual(JSON.parse(result.stdout), {
      path: output,
      contentType: "image/png",
      bytesWritten: png.length,
    });
    assert.equal(requests, 1);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("native static-map timeout includes the PNG body and leaves no output file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-native-map-timeout-"));
  let requests = 0;
  const { server, url } = await listen((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "image/png" });
    response.write(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
  try {
    const output = path.join(directory, "map.png"),
      result = await invoke(url, [
        "places",
        "static-map",
        "download",
        "--latitude",
        "0",
        "--longitude",
        "0",
        "--output",
        output,
        "--timeout-ms",
        "100",
      ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "TIMEOUT");
    assert.equal(requests, 1);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("native dashboard credential submission keeps provider credentials in the body and returns only safe metadata", async () => {
  let requests = 0,
    received = "";
  const timestamp = "2026-10-29T00:00:00.000Z",
    secret = "native-provider-secret";
  const input = {
    provider: "privy",
    fields: {
      credentialLabel: "Fixture",
      scope: "project",
      appId: "fixture-app",
      appSecret: secret,
    },
    requestDelayMs: 0,
  };
  const credential = {
    id: "pcred_fixture",
    provider: "privy",
    label: "Fixture",
    scope: "project",
    projectId: "prj_example",
    status: "pending",
    createdAt: timestamp,
    displayMetadata: { appIdSuffix: "-app" },
  };
  const envelope = {
    data: { providerCredential: credential, connectionId: "cconn_fixture" },
    meta: { requestId: "req_native_setup", timestamp },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/dashboard/custody/provider-credentials");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["idempotency-key"], "install-42");
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope));
    });
  });
  try {
    const result = await invoke(
      url,
      [
        "custody",
        "credentials",
        "submit",
        "--data",
        JSON.stringify(input),
        "--idempotency-key",
        "install-42",
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(received), input);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert(!result.stdout.includes(secret));
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native dashboard Fireblocks discovery POSTs API user IDs and fetches one cursor page", async () => {
  let requests = 0,
    received = "";
  const cursor = "opaque/+?=#",
    timestamp = "2026-10-29T00:00:00.000Z";
  const data = {
    vaults: [{ id: "0007", name: "Fixture vault", hasSolanaWallet: false }],
    nextCursor: cursor,
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/dashboard/custody/fireblocks/vaults/discover");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["idempotency-key"], undefined);
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data, meta: { requestId: "req_native_vaults", timestamp } }));
    });
  });
  try {
    const result = await invoke(
      url,
      [
        "custody",
        "fireblocks",
        "vaults",
        "discover",
        "--api-user-id",
        "fixture-api-user",
        "--signing-key-id",
        "fbcsr_00000000-0000-0000-0000-000000000000",
        "--after",
        cursor,
      ],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(received), {
      apiKey: "fixture-api-user",
      signingKeyId: "fbcsr_00000000-0000-0000-0000-000000000000",
      after: cursor,
    });
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native dashboard Rings creation redacts echoed keyed URLs and credentials without retry", async () => {
  let requests = 0;
  const credential = "provider-secret/+?$",
    endpoint = new URL("https://rpc.example/provider/path");
  endpoint.searchParams.set("api-key", credential);
  const input = {
    name: "Dashboard connection",
    solanaRpcUrl: endpoint.toString(),
    indexerUrl: "https://indexer.example",
    proverUrl: "https://prover.example",
    allowInsecureHttp: false,
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/internal/dashboard/helius-rings/connections");
    assert.equal(request.headers.authorization, "Bearer local-session");
    assert.equal(request.headers["x-project-id"], "prj_example");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["idempotency-key"], undefined);
    let received = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(received), input);
      response.writeHead(409, {
        "content-type": "application/json",
        "x-request-id": encodeURIComponent(credential),
      });
      response.end(
        JSON.stringify({
          error: {
            code: "CONFLICT",
            message: `Probe failed for ${input.solanaRpcUrl}`,
            details: { credential, reason: "probe_failed" },
          },
        })
      );
    });
  });
  try {
    const result = await invoke(
      url,
      ["helius-rings", "connections", "create", "--data", JSON.stringify(input)],
      { SDP_TOKEN: "local-session", SDP_PROJECT_ID: "prj_example" }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(requests, 1);
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code: "CONFLICT",
      message: "Probe failed for [REDACTED]",
      status: 409,
      requestId: "[REDACTED]",
      details: { credential: "[REDACTED]", reason: "probe_failed" },
    });
  } finally {
    await close(server);
  }
});

test("native dashboard network transport reads one unscoped snapshot with a human session", async () => {
  let requests = 0;
  const envelope = {
    data: {
      asOf: "2026-10-27",
      health: null,
      metrics: Object.fromEntries(NETWORK_METRIC_IDS.map((id) => [id, []])),
    },
    meta: { requestId: "req_native_network", timestamp: "2026-10-29T00:00:00.000Z" },
  };
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/internal/dashboard/network");
    assert.equal(request.headers.authorization, "Bearer network-session");
    for (const name of ["x-project-id", "x-organization-id", "idempotency-key", "content-type"])
      assert.equal(request.headers[name], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(envelope));
  });
  try {
    const denied = await invoke(url, ["network", "snapshot", "get"]);
    assert.equal(denied.code, 2);
    assert.equal(requests, 0);
    const result = await invoke(url, ["network", "snapshot", "get"], {
      SDP_TOKEN: "network-session",
      SDP_PROJECT_ID: "prj_ignored",
      SDP_ORGANIZATION_ID: "org_ignored",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), envelope);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("native webhook transport preserves signed payload bytes for Clerk and every ramp ingress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-native-webhook-"));
  const raw = Buffer.from('{\r\n "id": "evt_test", "text": "é🙂", "n":1e2, "n":2\r\n}\n');
  const timestamp = "1234567890",
    messageId = "msg_native",
    secret = "dummy-fixture-secret";
  const cases = [
    {
      args: ["webhooks", "clerk", "deliver"],
      path: "/webhooks/clerk",
      headers: {
        "svix-id": messageId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${createHmac("sha256", secret).update(`${messageId}.${timestamp}.`).update(raw).digest("base64")}`,
      },
      data: { received: true },
    },
    ...["sandbox", "production"].flatMap((environment) =>
      RAMP_PROVIDERS.map((provider) => ({
        args: ["webhooks", "ramps", environment, "deliver", provider],
        path: `/webhooks/payments/ramps/${environment}/${provider}`,
        headers: {
          [provider === "stripe" ? "stripe-signature" : "moonpay-signature-v2"]:
            `t=${timestamp},${provider === "stripe" ? "v1" : "s"}=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`,
        },
        data: { received: true, provider, environment },
      }))
    ),
  ];
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    const expected = cases[requests++];
    assert(expected);
    assert.equal(request.method, "POST");
    assert.equal(request.url, expected.path);
    assert.equal(request.headers["content-type"], "application/json");
    for (const name of ["authorization", "x-project-id", "x-organization-id", "idempotency-key"])
      assert.equal(request.headers[name], undefined);
    for (const [name, value] of Object.entries(expected.headers))
      assert.equal(request.headers[name], value);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      assert.deepEqual(Buffer.concat(chunks), raw);
      // The values captured above authenticate these exact bytes, including CRLF,
      // duplicate JSON keys, and the original numeric and Unicode representation.
      const prefix = expected.args[1] === "clerk" ? `${messageId}.${timestamp}.` : `${timestamp}.`;
      const encoding = expected.args[1] === "clerk" ? "base64" : "hex";
      const digest = createHmac("sha256", secret)
        .update(prefix)
        .update(Buffer.concat(chunks))
        .digest(encoding);
      assert(Object.values(expected.headers).some((value) => value.endsWith(digest)));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: expected.data,
          meta: { requestId: "req_signed_ingress", timestamp: "2026-10-29T00:00:00.000Z" },
        })
      );
    });
  });
  try {
    const body = path.join(directory, "body.json"),
      headers = path.join(directory, "headers.json");
    await writeFile(body, raw);
    for (const item of cases) {
      await writeFile(headers, JSON.stringify(item.headers));
      const result = await invoke(
        url,
        [...item.args, "--body", `@${body}`, "--headers", `@${headers}`],
        {
          SDP_API_KEY: "ignored-key",
          SDP_TOKEN: "ignored-token",
          SDP_PROJECT_ID: "prj_ignored",
        }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).data, item.data);
    }
    assert.equal(requests, cases.length);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("native health and discovery transport preserves diagnostics, conditional documents, text and redirects", async () => {
  const timestamp = "2026-10-29T00:00:00.000Z",
    etag = 'W/"native-document"';
  const health = {
    status: "ok",
    timestamp,
    version: "v1",
    environment: "production",
    releaseChannel: "stable",
  };
  const report = {
    status: "not_ready",
    timestamp,
    revision: "native-revision",
    commit: "local",
    checks: { database: "ok", redis: "error" },
  };
  const document = { openapi: "3.0.3", info: { title: "Native API", version: "0.1.0" }, paths: {} };
  const html = "<!doctype html>\n<html>é</html>\n",
    text = "# Native discovery\n";
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    for (const name of [
      "authorization",
      "x-project-id",
      "x-organization-id",
      "idempotency-key",
      "content-type",
    ])
      assert.equal(request.headers[name], undefined);
    switch (request.url) {
      case "/health":
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(health));
        break;
      case "/health/ready":
        response.writeHead(503, {
          "content-type": "application/json",
          "x-request-id": "req_native_ready",
        });
        response.end(JSON.stringify(report));
        break;
      case "/openapi.json":
        response.setHeader("etag", etag);
        response.setHeader("cache-control", "public, max-age=3600");
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304);
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(document));
        }
        break;
      case "/docs":
        assert.equal(request.headers.accept, "text/html, application/json");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        break;
      case "/llms.txt":
        assert.equal(request.headers.accept, "text/plain, application/json");
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(text);
        break;
      case "/":
        response.writeHead(302, { location: "/health" });
        response.end();
        break;
      default:
        throw new Error(`Unexpected request ${request.url}`);
    }
  });
  const env = {
    SDP_API_KEY: "ignored-key",
    SDP_TOKEN: "ignored-token",
    SDP_PROJECT_ID: "prj_ignored",
  };
  try {
    const check = await invoke(url, ["health", "check"], env);
    assert.equal(check.code, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout), health);
    const ready = await invoke(url, ["health", "readiness"], env);
    assert.equal(ready.code, 1);
    assert.equal(ready.stdout, "");
    assert.deepEqual(JSON.parse(ready.stderr).error.details, report);
    const first = await invoke(url, ["api", "openapi", "get", "--include-headers"], env);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).body, document);
    assert.equal(JSON.parse(first.stdout).headers.etag, etag);
    const cached = await invoke(url, ["api", "openapi", "get", "--if-none-match", etag], env);
    assert.equal(cached.code, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout).notModified, true);
    const docs = await invoke(url, ["api", "docs", "get"], env),
      llms = await invoke(url, ["api", "ai-discovery", "get"], env);
    assert.equal(docs.code, 0, docs.stderr);
    assert.equal(JSON.parse(docs.stdout), html);
    assert.equal(llms.code, 0, llms.stderr);
    assert.equal(JSON.parse(llms.stdout), text);
    const root = await invoke(url, ["api", "root-redirect", "get"], env);
    assert.equal(root.code, 0, root.stderr);
    assert.deepEqual(JSON.parse(root.stdout), { status: 302, location: "/health" });
    assert.equal(requests, 7);
  } finally {
    await close(server);
  }
});

test("native discovery deadlines cover the complete text body without partial stdout", async () => {
  let requests = 0;
  const { server, url } = await listen((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<!doctype html><html>");
  });
  try {
    const result = await invoke(url, ["api", "docs", "get", "--timeout-ms", "100"], {});
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(requests, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "TIMEOUT");
  } finally {
    await close(server);
  }
});

test("native wallet balances and onboarding reads keep slot, project and session scopes separate", async () => {
  const timestamp = "2026-10-29T00:00:00.000Z";
  const walletId = "provider/wallet?#";
  const walletBalances = {
    walletId,
    address: SOL_MINT,
    balances: [
      {
        token: "SOL",
        mint: SOL_MINT,
        amount: "9007199254740993",
        uiAmount: "9007199.254740993",
        decimals: 9,
      },
    ],
  };
  const unlinked = { linked: false, organization: null, setup: null };
  let requests = 0;
  const { server, url } = await listen((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.headers["content-type"], undefined);
    assert.equal(request.headers["idempotency-key"], undefined);
    assert(request.url);
    const target = new URL(request.url, "http://localhost");
    if (target.pathname === "/v1/onboarding/status") {
      assert.equal(request.headers.authorization, "Bearer onboarding-session");
      assert.equal(request.headers["x-project-id"], undefined);
      assert.equal(target.search, "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: unlinked, meta: { requestId: "req_onboarding", timestamp } })
      );
      return;
    }
    assert.equal(target.pathname, "/v1/payments/wallets/provider%2Fwallet%3F%23/balances");
    if (target.searchParams.has("minimumSlot")) {
      const slot = target.searchParams.get("minimumSlot");
      assert(slot !== null);
      if (slot === "0") {
        assert.equal(request.headers.authorization, "Bearer balance-session");
        assert.equal(request.headers["x-project-id"], "prj_selected");
      } else {
        assert.equal(slot, "9007199254740991");
        assert.equal(request.headers.authorization, "Bearer local-test-key");
        assert.equal(request.headers["x-project-id"], undefined);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: { walletBalances, balanceReadContext: { minimumSlot: Number(slot) } },
          meta: { requestId: "req_balances", timestamp },
        })
      );
    } else {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "PROVIDER_UNAVAILABLE", message: "No partial balances" },
          meta: { requestId: "req_unavailable" },
        })
      );
    }
  });
  try {
    const max = await invoke(url, [
      "wallets",
      "balances",
      "get",
      walletId,
      "--minimum-slot",
      "9007199254740991",
    ]);
    assert.equal(max.code, 0, max.stderr);
    assert.deepEqual(JSON.parse(max.stdout).data.walletBalances, walletBalances);
    const zero = await invoke(
      url,
      ["wallets", "balances", "get", walletId, "--minimum-slot", "0"],
      {
        SDP_TOKEN: "balance-session",
        SDP_PROJECT_ID: "prj_selected",
      }
    );
    assert.equal(zero.code, 0, zero.stderr);
    assert.equal(JSON.parse(zero.stdout).data.balanceReadContext.minimumSlot, 0);
    const failed = await invoke(url, ["wallets", "balances", "get", walletId]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.equal(JSON.parse(failed.stderr).error.code, "PROVIDER_UNAVAILABLE");
    const onboarding = await invoke(url, ["onboarding", "status", "get"], {
      SDP_TOKEN: "onboarding-session",
      SDP_PROJECT_ID: "prj_ignored",
    });
    assert.equal(onboarding.code, 0, onboarding.stderr);
    assert.deepEqual(JSON.parse(onboarding.stdout).data, unlinked);
    assert.equal(requests, 4);
  } finally {
    await close(server);
  }
});
