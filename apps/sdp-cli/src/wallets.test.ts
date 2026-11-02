import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { runCli } from "./run";

const session = {
  SDP_TOKEN: "wallet-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const apiKey = { SDP_API_KEY: "wallet-api-key", SDP_API_URL: session.SDP_API_URL };
const meta = { requestId: "req_wallets", timestamp: "2026-01-01T00:00:00.000Z" };
const walletFields = {
  id: "cwlt_example",
  walletId: "privy_provider_wallet",
  provider: "privy",
  isRuntimeExecutionAllowed: true,
  publicKey: SOL_MINT,
  label: "Treasury",
  purpose: "transfer",
  status: "active",
  createdAt: meta.timestamp,
};
const managed = { ...walletFields, custodyConfigId: "cfg_example" };
const connected = { ...walletFields, custodyConnectionId: "cconn_example" };
const balance = {
  token: "SOL",
  mint: SOL_MINT,
  amount: "900719925474099300000",
  uiAmount: "900719925474.0993",
  decimals: 9,
};
const mutations = [
  ["wallets", "create", "--provider", "privy"],
  ["wallets", "delete", "--wallet-id", walletFields.walletId],
  ["wallets", "update", walletFields.walletId, "--label", "Updated"],
  ["wallets", "signer", "check", "--wallet-id", walletFields.walletId],
];
const reads = [
  ["wallets", "list"],
  ["wallets", "managed-signing", "configurations", "list"],
  ["wallets", "balances", "aggregate"],
  ["wallets", "get", walletFields.walletId],
  ["wallets", "public-key", "get", "--wallet-id", walletFields.walletId],
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
  let stdout = "";
  let stderr = "";
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
function walletResponse(status: number): Response {
  return Response.json({ data: { wallet: managed }, meta }, { status });
}
function initialized(): Response {
  return Response.json(
    {
      data: { configId: "cfg_example", publicKey: SOL_MINT, walletId: walletFields.walletId },
      meta,
    },
    { status: 201 }
  );
}
function signerResponse(): Response {
  return Response.json({
    data: {
      walletId: walletFields.walletId,
      walletAddress: SOL_MINT,
      feePayer: SOL_MINT,
      memo: "SDP signer check fixture",
      signature: "fixture-signature",
      simulated: true,
      checkedAt: meta.timestamp,
    },
    meta,
  });
}
function headers(request: RecordedRequest): Headers {
  return new Headers(request.init.headers);
}

test("wallet help covers all ten commands, exact IDs, and signer simulation", async () => {
  for (const args of [
    ["wallets"],
    ["wallets", "create", "--help"],
    ["wallets", "get", "--help"],
    ["wallets", "managed-signing", "initialize-with-wallet", "--help"],
    ["wallets", "signer", "check", "--help"],
  ]) {
    const result = await invoke(args, walletResponse(200), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[1] === "signer-check") assert(result.stdout.includes("Nothing is broadcast"));
    if (args[1] === "get") assert(result.stdout.includes("<walletId>"));
    if (args[1] === "initialize") assert(result.stdout.includes("Clerk session"));
  }
});

test("wallet lists forward provider, summary view and balance flags with an API key", async () => {
  const data = { wallets: [{ ...managed, balances: [balance] }, connected] };
  const result = await invoke(
    ["wallets", "list", "--provider", "privy", "--view", "summary", "--include-balances"],
    Response.json({ data, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  const url = new URL(result.requests[0].url);
  assert.equal(url.pathname, "/v1/wallets");
  assert.equal(url.searchParams.get("provider"), "privy");
  assert.equal(url.searchParams.get("view"), "summary");
  assert.equal(url.searchParams.get("includeBalances"), "true");
  assert.equal(headers(result.requests[0]).get("authorization"), `Bearer ${apiKey.SDP_API_KEY}`);
  assert.equal(headers(result.requests[0]).get("x-project-id"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data, meta });
});

test("wallet reads request no optional balances unless selected by the caller", async () => {
  const list = await invoke(
    ["wallets", "list"],
    Response.json({ data: { wallets: [managed] }, meta })
  );
  assert.equal(list.code, 0, list.stderr);
  assert.equal(new URL(list.requests[0].url).search, "");
  const get = await invoke(
    ["wallets", "get", walletFields.walletId, "--include-balance", "false"],
    walletResponse(200)
  );
  assert.equal(get.code, 0, get.stderr);
  assert.equal(new URL(get.requests[0].url).searchParams.get("includeBalance"), "false");
  assert.equal(get.requests.length, 1);
});

test("wallet detail keeps large balance amounts as strings", async () => {
  const data = { wallet: { ...connected, balance } };
  const result = await invoke(
    ["wallets", "get", walletFields.walletId, "--include-balance", "true"],
    Response.json({ data, meta }),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.wallet.balance.amount, balance.amount);
  assert.equal(
    result.requests[0].url,
    `http://localhost:8787/v1/wallets/${walletFields.walletId}?includeBalance=true`
  );
});

test("wallet reads reject literal routes masquerading as wallet IDs", async () => {
  for (const id of ["public-key"]) {
    const result = await invoke(["wallets", "get", id], walletResponse(200));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("different API route"));
  }
});

test("config and aggregate reads preserve their response envelopes", async () => {
  const configs = {
    configs: [
      {
        id: "cfg_example",
        organizationId: "org_example",
        projectId: session.SDP_PROJECT_ID,
        provider: "privy",
        status: "active",
        createdAt: meta.timestamp,
      },
    ],
  };
  const listed = await invoke(
    ["wallets", "managed-signing", "configurations", "list"],
    Response.json({ data: configs, meta })
  );
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).data, configs);
  const aggregate = { aggregate: { walletCount: 2, balances: [balance] } };
  const aggregated = await invoke(
    ["wallets", "balances", "aggregate", "--provider", "privy"],
    Response.json({ data: aggregate, meta })
  );
  assert.equal(aggregated.code, 0, aggregated.stderr);
  assert.equal(
    aggregated.requests[0].url,
    "http://localhost:8787/v1/wallets/balances/aggregate?provider=privy"
  );
  assert.deepEqual(JSON.parse(aggregated.stdout).data, aggregate);
});

test("public-key lookup requires one provider wallet ID in the query", async () => {
  const result = await invoke(
    ["wallets", "public-key", "get", "--wallet-id", "provider_id/with?#"],
    Response.json({ data: { publicKey: SOL_MINT }, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(new URL(result.requests[0].url).pathname, "/v1/wallets/public-key");
  assert.equal(new URL(result.requests[0].url).searchParams.get("walletId"), "provider_id/with?#");
  assert.equal(JSON.parse(result.stdout).data.publicKey, SOL_MINT);
  assert.equal(result.requests.length, 1);
});

test("creation names exactly one Managed provider or BYOK connection", async () => {
  for (const [args, body, wallet] of [
    [["--provider", "privy"], { provider: "privy" }, managed],
    [["--connection-id", "cconn_example"], { connectionId: "cconn_example" }, connected],
  ] as const) {
    const result = await invoke(
      [
        "wallets",
        "create",
        ...args,
        "--label",
        "Treasury",
        "--purpose",
        "transfer",
        "--idempotency-key",
        "wallet-create-1",
      ],
      Response.json({ data: { wallet }, meta }, { status: 201 }),
      { env: apiKey }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
      ...body,
      label: "Treasury",
      purpose: "transfer",
    });
    assert.equal(headers(result.requests[0]).get("idempotency-key"), "wallet-create-1");
    assert.equal(result.requests.length, 1);
  }
});

test("initialization uses a session and the provider's declared input variant", async () => {
  const result = await invoke(
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "privy",
      "--wallet-label",
      "Root",
      "--request-delay-ms",
      "0",
      "--idempotency-key",
      "initialize-1",
    ],
    initialized()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    provider: "privy",
    walletLabel: "Root",
    requestDelayMs: 0,
  });
  assert.equal(headers(result.requests[0]).get("x-project-id"), session.SDP_PROJECT_ID);
  assert.equal(JSON.parse(result.stdout).data.configId, "cfg_example");
  const cdp = await invoke(
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "coinbase_cdp",
      "--network",
      "solana-devnet",
      "--account-policy",
      "123e4567-e89b-42d3-a456-426614174000",
    ],
    initialized()
  );
  assert.equal(cdp.code, 0, cdp.stderr);
  assert.equal(JSON.parse(String(cdp.requests[0].init.body)).network, "solana-devnet");
  const denied = await invoke(
    ["wallets", "managed-signing", "initialize-with-wallet", "--provider", "privy"],
    initialized(),
    {
      env: apiKey,
    }
  );
  assert.equal(denied.code, 2);
  assert.equal(denied.requests.length, 0);
});

test("wallet mutations support inline JSON, files, and stdin without adding defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-wallet-"));
  try {
    const file = path.join(directory, "wallet.json");
    const body = JSON.stringify({ connectionId: "cconn_example" });
    await writeFile(file, body);
    for (const source of [body, `@${file}`, "-"]) {
      const result = await invoke(["wallets", "create", "--data", source], walletResponse(201), {
        stdin: body,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.requests[0].init.body, body);
    }
    const initializedJson = await invoke(
      ["wallets", "managed-signing", "initialize-with-wallet", "--data", "-"],
      initialized(),
      {
        stdin: '{"provider":"privy","requestDelayMs":0}',
      }
    );
    assert.equal(initializedJson.code, 0, initializedJson.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wallet label updates and explicit null clearing use the provider wallet path", async () => {
  for (const [args, label] of [
    [["--label", "Updated"], "Updated"],
    [["--clear-label"], null],
  ] as const) {
    const result = await invoke(
      ["wallets", "update", "wallet/with?#", ...args, "--idempotency-key", "wallet-update-1"],
      walletResponse(200)
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "PATCH");
    assert.equal(new URL(result.requests[0].url).pathname, "/v1/wallets/wallet%2Fwith%3F%23");
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { label });
  }
});

test("wallet deletion sends its provider assertion and wallet ID in a DELETE body", async () => {
  const result = await invoke(
    [
      "wallets",
      "delete",
      "--provider",
      "privy",
      "--wallet-id",
      walletFields.walletId,
      "--idempotency-key",
      "delete-1",
    ],
    Response.json({ data: { walletId: walletFields.walletId, deleted: true }, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/wallets");
  assert.equal(result.requests[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    provider: "privy",
    walletId: walletFields.walletId,
  });
});

test("signer-check requests only the named wallet and preserves simulated output", async () => {
  const result = await invoke(
    [
      "wallets",
      "signer",
      "check",
      "--wallet-id",
      walletFields.walletId,
      "--idempotency-key",
      "check-1",
    ],
    signerResponse(),
    { env: apiKey }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/wallets/signer-check");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    walletId: walletFields.walletId,
  });
  assert.equal(JSON.parse(result.stdout).data.simulated, true);
  assert.equal(result.requests.length, 1);
});

test("session wallet operations require project selection before any request", async () => {
  for (const args of [
    ...reads,
    ...mutations,
    ["wallets", "managed-signing", "initialize-with-wallet", "--provider", "privy"],
  ]) {
    const result = await invoke(args, walletResponse(200), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("invalid wallet ownership, provider fields, IDs and labels are rejected locally", async () => {
  const cases = [
    ["wallets", "create"],
    ["wallets", "create", "--provider", "privy", "--connection-id", "cconn_example"],
    ["wallets", "create", "--provider", "privy", "--purpose", "root"],
    ["wallets", "create", "--data", '{"provider":"privy","projectId":"prj_other"}'],
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "privy",
      "--request-delay-ms",
      "3001",
    ],
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "privy",
      "--request-delay-ms",
      "0.5",
    ],
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "privy",
      "--network",
      "solana-devnet",
    ],
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--provider",
      "coinbase_cdp",
      "--account-policy",
      "invalid",
    ],
    [
      "wallets",
      "managed-signing",
      "initialize-with-wallet",
      "--data",
      '{"provider":"privy","apiKey":"do-not-send"}',
    ],
    ["wallets", "list", "--provider", "unknown"],
    ["wallets", "list", "--view", "unknown"],
    ["wallets", "get", walletFields.walletId, "--include-balance", "invalid"],
    ["wallets", "public-key", "get"],
    ["wallets", "delete"],
    ["wallets", "signer", "check"],
    ["wallets", "public-key", "get", "--wallet-id", "one", "--wallet-id", "two"],
    ["wallets", "delete", "--wallet-id", "one", "--wallet-id", "two"],
    ["wallets", "get"],
    ["wallets", "get", ".."],
    ["wallets", "update", walletFields.walletId],
    ["wallets", "update", walletFields.walletId, "--label", "Text", "--clear-label"],
    ["wallets", "signer", "check", "--data", '{"walletId":"provider_id","memo":"user text"}'],
    ["wallets", "create", "--provider", "privy", "--data", '{"connectionId":"cconn_example"}'],
  ];
  for (const args of cases) {
    const result = await invoke(args, walletResponse(200));
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
  }
});

test("responses must name exactly one wallet owner", async () => {
  for (const wallet of [walletFields, { ...managed, custodyConnectionId: "cconn_example" }]) {
    const result = await invoke(
      ["wallets", "get", walletFields.walletId],
      Response.json({ data: { wallet }, meta })
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});

test("wallet balances can be absent or explicit zero without invented balances", async () => {
  for (const wallet of [
    { ...connected, purpose: null },
    { ...managed, balances: [] },
  ]) {
    const result = await invoke(
      ["wallets", "list"],
      Response.json({ data: { wallets: [wallet] }, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data.wallets[0], wallet);
  }
});

test("wallet provider failures and quotas are preserved without automatic retries", async () => {
  for (const status of [403, 409, 422, 429, 503]) {
    const result = await invoke(
      ["wallets", "create", "--provider", "privy", "--idempotency-key", "create-1"],
      Response.json(
        { error: { code: "PROVIDER_REFUSED", message: "Provider request failed" }, meta },
        { status }
      )
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.status, status);
  }
  const timedOut = await invoke(["wallets", "create", "--provider", "privy"], walletResponse(201), {
    failure: new DOMException("private upstream details", "TimeoutError"),
  });
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.requests.length, 1);
  assert(!timedOut.stderr.includes("private upstream"));
});
