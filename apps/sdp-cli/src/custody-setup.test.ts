import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CUSTODY_PROVIDERS, WALLET_FAUCET_STATUSES } from "@sdp/types/custody";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Command } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { custodyCommands } from "./custody-commands";
import { runCli } from "./run";

const meta = { requestId: "req_custody_setup", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "custody-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const secret = 'fixture-secret/$+?"\nend';
const apiUserId = "fixture-api-user/$+?";
const signingKeyId = "fbcsr_00000000-0000-0000-0000-000000000000";
const authentication = { appId: "fixture-app", appSecret: secret };
const privySetup = {
  provider: "privy",
  fields: { ...authentication, credentialLabel: "Treasury", scope: "project" },
};
const fireblocksSetup = {
  provider: "fireblocks",
  fields: {
    credentialLabel: "Fireblocks",
    scope: "project",
    apiKey: apiUserId,
    vaultAccountId: "0007",
    signingKeyId,
  },
  fireblocksVaultAccountIds: ["0007", "0008"],
};
const credential = {
  id: "pcred_example",
  provider: "privy",
  label: "Treasury",
  scope: "project",
  projectId: session.SDP_PROJECT_ID,
  status: "pending",
  createdAt: meta.timestamp,
  displayMetadata: { appIdSuffix: "-app" },
};
const connection = {
  id: "cconn_example",
  provider: "privy",
  label: credential.label,
  status: "pending",
  completion: null,
  walletLabel: "Ops",
  canComplete: true,
  canReplaceCredentials: true,
  canCancel: true,
};
const csr = {
  id: signingKeyId,
  csrPem:
    "-----BEGIN CERTIFICATE REQUEST-----\nfixture-public-csr\n-----END CERTIFICATE REQUEST-----",
  expiresAt: meta.timestamp,
};
const discovery = { apiKey: apiUserId, signingKeyId };
const pathValues: Record<string, string> = {
  connectionId: "connection/example?#",
  credentialId: "credential/example?#",
  walletId: "wallet/example?#",
};
const bodySamples: Record<string, JsonObject> = {
  submitCustodySetupCredentials: privySetup,
  replaceCustodySetupCredentials: privySetup,
  rotateCustodySetupCredential: { provider: "privy", fields: authentication },
  createCustodyFireblocksCsr: {},
  discoverCustodyFireblocksVaults: discovery,
  requestDashboardWalletFaucet: {},
};
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  reply: Response = error(),
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
      return reply;
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
function error(status = 403, code = "FORBIDDEN", details?: JsonObject) {
  return Response.json(
    {
      error: {
        code,
        message: "Custody setup refused",
        ...(details === undefined ? {} : { details }),
      },
      meta,
    },
    { status }
  );
}
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}
function argsFor(command: Command) {
  const operation = operationById(command.operationId),
    args = [...command.words];
  for (const p of operation.parameters) {
    if (p.location === "path") {
      assert(pathValues[p.name]);
      args.push(pathValues[p.name]);
    }
    if (p.location === "header" && p.name.toLowerCase() === "idempotency-key")
      args.push("--idempotency-key", "explicit-intent-42");
  }
  if (operation.body !== null) {
    assert(bodySamples[command.operationId], command.operationId);
    args.push("--data", JSON.stringify(bodySamples[command.operationId]));
  }
  if (command.operationId === "getDashboardFireblocksDestination")
    args.push(
      "--custody-wallet-id",
      "cwlt_example",
      "--counterparty-id",
      "cpty_example",
      "--counterparty-account-id",
      "acct_example",
      "--address",
      SOL_MINT,
      "--asset",
      "SOL"
    );
  return args;
}

test("all 18 dashboard custody commands provide offline scoped help", async () => {
  assert.equal(custodyCommands.length, 18);
  for (const args of [["custody"], ...custodyCommands.map((c) => [...c.words, "--help"])]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  const help = await invoke(
    ["custody", "fireblocks", "destination-eligibility", "get", "--help"],
    error(),
    {
      env: {},
    }
  );
  assert(help.stdout.includes("wallets.read"));
  assert(help.stdout.includes("counterparties.read"));
});
test("every command uses its exact generated route, method, session scope, and body", async () => {
  for (const command of custodyCommands) {
    const operation = operationById(command.operationId),
      result = await invoke(argsFor(command));
    assert.equal(result.code, 1, `${command.operationId}: ${result.stderr}`);
    assert.equal(result.requests.length, 1, command.operationId);
    const request = result.requests[0];
    let pathname = operation.path;
    for (const p of operation.parameters.filter((p) => p.location === "path"))
      pathname = pathname.replace(`{${p.name}}`, encodeURIComponent(pathValues[p.name]));
    assert.equal(new URL(request.url).pathname, pathname);
    assert.equal(request.init.method, operation.method);
    assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer custody-session");
    assert.equal(new Headers(request.init.headers).get("x-project-id"), session.SDP_PROJECT_ID);
    if (operation.body === null) assert.equal(request.init.body, undefined);
    else assert.deepEqual(body(request), bodySamples[command.operationId]);
  }
});
test("all dashboard helpers refuse API keys and require a project for member sessions", async () => {
  for (const command of custodyCommands) {
    assert.equal(operationById(command.operationId).sessionOnly, true);
    for (const env of [{ SDP_API_KEY: "account-key" }, { SDP_TOKEN: session.SDP_TOKEN }]) {
      const result = await invoke(argsFor(command), error(), { env });
      assert.equal(result.code, 2);
      assert.equal(result.requests.length, 0);
    }
  }
});
test("the four keyed writes require caller-chosen keys and do not synthesize any", async () => {
  const keyed = custodyCommands.filter((c) => "idempotency-key" in c.flags);
  assert.equal(keyed.length, 4);
  for (const command of keyed) {
    const args = argsFor(command),
      index = args.indexOf("--idempotency-key");
    args.splice(index, 2);
    const result = await invoke(args);
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("provider status preserves all canonical providers and independent signing targets", async () => {
  const providers = CUSTODY_PROVIDERS.map((provider) => ({
    provider,
    hasLegacyConfig: false,
    effectiveTargetType: "none",
    connectionCounts: { pending: 1, checking: 0, active: 1, failed: 0, deactivated: 0 },
  }));
  const result = await invoke(["custody", "providers", "list"], response({ providers }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.providers, providers);
  assert.equal(result.requests.length, 1);
});
test("connection inventory forwards filters before server paging without applying its own defaults", async () => {
  const row = {
    id: connection.id,
    provider: "privy",
    label: credential.label,
    status: "active",
    isRuntimeExecutionAllowed: false,
    createdAt: meta.timestamp,
    activatedAt: null,
    lastCheck: { status: "retry_unknown", at: null, failureCode: "provider_response_unknown" },
    pendingWalletLabel: null,
  };
  const result = await invoke(
    ["custody", "connections", "list", "--provider", "privy", "--limit", "0", "--offset", "1.7"],
    response({ connections: [row], pagination: { limit: 1, offset: 1, total: 2 } })
  );
  assert.equal(result.code, 0, result.stderr);
  const query = new URL(result.requests[0].url).searchParams;
  assert.equal(query.get("provider"), "privy");
  assert.equal(query.get("limit"), "0");
  assert.equal(query.get("offset"), "1.7");
  assert.equal(JSON.parse(result.stdout).data.connections[0].isRuntimeExecutionAllowed, false);
  const plain = await invoke(
    ["custody", "connections", "list"],
    response({ connections: [], pagination: { limit: 20, offset: 0, total: 0 } })
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(new URL(plain.requests[0].url).search, "");
});
test("Privy submission preserves zero delay and remains a pending installation", async () => {
  const result = await invoke(
    [
      "custody",
      "credentials",
      "submit",
      "--provider",
      "privy",
      "--fields",
      JSON.stringify(privySetup.fields),
      "--request-delay-ms",
      "0",
      "--wallet-label",
      "Ops",
      "--idempotency-key",
      "install-42",
    ],
    response({ providerCredential: credential, connectionId: connection.id }, 201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), {
    ...privySetup,
    requestDelayMs: 0,
    walletLabel: "Ops",
  });
  assert.equal(result.requests.length, 1);
  assert.equal(JSON.parse(result.stdout).data.providerCredential.status, "pending");
  assert(!result.stdout.includes(secret));
});
test("Fireblocks submissions retain string vault IDs and the API-generated signing key reference", async () => {
  const result = await invoke(
    [
      "custody",
      "connections",
      "replace-credentials",
      connection.id,
      "--provider",
      "fireblocks",
      "--fields",
      JSON.stringify(fireblocksSetup.fields),
      "--fireblocks-vault-account-ids",
      '["0007","0008"]',
      "--idempotency-key",
      "replace-42",
    ],
    response(
      {
        providerCredential: {
          ...credential,
          provider: "fireblocks",
          displayMetadata: { apiKeySuffix: "user", primaryVaultId: "0007" },
        },
        connectionId: connection.id,
      },
      201
    )
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), fireblocksSetup);
  assert.equal(result.requests.length, 1);
});
test("installation reads and explicit completion preserve all recorded outcomes without follow-up", async () => {
  const read = await invoke(
    ["custody", "connections", "get", connection.id],
    response({ connection })
  );
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).data.connection.canComplete, true);
  for (const status of ["running", "success", "failed", "retry_unknown"]) {
    const result = await invoke(
      ["custody", "connections", "complete-installation", connection.id],
      response({
        providerCredential: credential,
        connectionId: connection.id,
        completion: { status, attemptedAt: meta.timestamp },
      })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stdout).data.completion.status, status);
  }
});
test("cancel and connection deactivation preserve their distinct response keys", async () => {
  const cases: [string, JsonObject][] = [
    [
      "cancel-installation",
      { connection: { ...connection, status: "deactivated", canComplete: false } },
    ],
    [
      "deactivate",
      { custodyConnection: { ...connection, status: "deactivated", canComplete: false } },
    ],
  ];
  for (const [verb, data] of cases) {
    const result = await invoke(["custody", "connections", verb, connection.id], response(data));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests[0].init.body, undefined);
  }
});
test("credential lifecycle retains impact, nullable candidates, and rollback expiry", async () => {
  const current = { ...credential, status: "active", source: "stored" },
    data = {
      providerCredential: current,
      rotationCandidate: null,
      impact: {
        projects: [{ id: session.SDP_PROJECT_ID, name: "Fixture project" }],
        connections: [{ id: connection.id, projectId: session.SDP_PROJECT_ID, status: "active" }],
      },
      rollback: {
        providerCredential: { ...current, id: "pcred_previous", status: "retired" },
        expiresAt: meta.timestamp,
      },
    };
  const result = await invoke(
    ["custody", "connections", "credential-lifecycle", "get", connection.id],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
});
test("rotation uses registration fields only and preserves failure and retry_unknown results", async () => {
  const result = await invoke(
    [
      "custody",
      "credentials",
      "rotate",
      credential.id,
      "--provider",
      "privy",
      "--fields",
      JSON.stringify(authentication),
      "--idempotency-key",
      "rotate-42",
    ],
    response({
      providerCredential: { ...credential, id: "pcred_candidate" },
      rotation: { status: "retry_unknown", code: "provider_response_unknown" },
    })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { provider: "privy", fields: authentication });
  assert.equal(result.requests.length, 1);
  const rotations: JsonObject[] = [
    { status: "success" },
    { status: "failed", code: "provider_account_mismatch" },
    { status: "retry_unknown", code: "provider_response_unknown" },
  ];
  for (const rotation of rotations) {
    const result = await invoke(
      ["custody", "credentials", "complete-rotation", credential.id],
      response({ providerCredential: credential, rotation })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(result.requests.length, 1);
  }
});
test("rollback and credential deactivation remain explicit actions on the named credential", async () => {
  for (const verb of ["rollback-rotation", "deactivate"]) {
    const data = {
        providerCredential: {
          ...credential,
          status: verb === "rollback-rotation" ? "active" : "deactivated",
        },
      },
      result = await invoke(["custody", "credentials", verb, credential.id], response(data));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].init.body, undefined);
  }
});
test("Fireblocks CSR commands return public CSR data or null and create with an explicit empty body", async () => {
  const absent = await invoke(["custody", "fireblocks", "csr", "get"], response({ csr: null }));
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).data.csr, null);
  const created = await invoke(
    ["custody", "fireblocks", "csr", "create", "--idempotency-key", "csr-42"],
    response({ csr }, 201)
  );
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(body(created.requests[0]), {});
  assert.deepEqual(JSON.parse(created.stdout).data.csr, csr);
  assert.equal(created.requests.length, 1);
});
test("Fireblocks vault discovery POSTs identifiers and cursor and fetches one page", async () => {
  const after = "opaque/+?=#",
    data = { vaults: [{ id: "0007", name: "Vault", hasSolanaWallet: false }], nextCursor: after };
  const result = await invoke(
    [
      "custody",
      "fireblocks",
      "vaults",
      "discover",
      "--api-user-id",
      apiUserId,
      "--signing-key-id",
      signingKeyId,
      "--after",
      after,
      "--name-prefix",
      "Ops",
    ],
    response(data)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { ...discovery, after, namePrefix: "Ops" });
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.equal(
    new Headers(result.requests[0].init.headers).get("authorization"),
    "Bearer custody-session"
  );
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests.length, 1);
});
test("destination checks use exact custody and counterparty IDs without sending a payment", async () => {
  const command = custodyCommands.find(
    (c) => c.operationId === "getDashboardFireblocksDestination"
  );
  assert(command);
  for (const state of ["approved", "pending", "not_whitelisted"]) {
    const result = await invoke(argsFor(command), response({ state, assetId: "SOL_TEST" }));
    assert.equal(result.code, 0, result.stderr);
    const query = new URL(result.requests[0].url).searchParams;
    assert.equal(query.get("walletId"), "cwlt_example");
    assert.equal(query.get("accountId"), "acct_example");
    assert.equal(query.get("counterpartyId"), "cpty_example");
    assert.equal(query.get("token"), "SOL");
    assert.equal(query.get("address"), SOL_MINT);
    assert.equal(result.requests.length, 1);
  }
});
test("the dashboard faucet sends no caller amount and preserves lamport strings and timeout outcomes", async () => {
  for (const status of WALLET_FAUCET_STATUSES) {
    const result = await invoke(
      ["custody", "wallets", "request-faucet", "cwlt_example"],
      response({ signature: "fixture_signature", status, lamports: "1000000000" })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), {});
    assert.equal(JSON.parse(result.stdout).data.lamports, "1000000000");
    assert.equal(result.requests.length, 1);
  }
});
test("setup JSON supports inline, file and stdin without retaining credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-custody-input-"));
  try {
    const file = path.join(directory, "credential.json"),
      encoded = JSON.stringify(privySetup);
    await writeFile(file, encoded);
    for (const source of [encoded, `@${file}`, "-"]) {
      const result = await invoke(
        ["custody", "credentials", "submit", "--data", source, "--idempotency-key", "install-42"],
        response({ providerCredential: credential, connectionId: connection.id }, 201),
        { stdin: encoded }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), privySetup);
      assert(!result.stdout.includes(secret));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("invalid provider variants, raw private keys, unsupported recovery flags, and secret typos fail locally", async () => {
  const invalid: string[][] = [
    [
      "credentials",
      "submit",
      "--data",
      JSON.stringify({ ...privySetup, provider: "local" }),
      "--idempotency-key",
      "key",
    ],
    [
      "credentials",
      "submit",
      "--data",
      JSON.stringify({ ...privySetup, fields: { ...privySetup.fields, appSecrett: secret } }),
      "--idempotency-key",
      "key",
    ],
    [
      "credentials",
      "submit",
      "--data",
      JSON.stringify({
        ...fireblocksSetup,
        fields: { ...fireblocksSetup.fields, apiSecretPem: "private-key-is-not-accepted" },
      }),
      "--idempotency-key",
      "key",
    ],
    [
      "credentials",
      "rotate",
      credential.id,
      "--data",
      JSON.stringify(privySetup),
      "--idempotency-key",
      "key",
    ],
    ["connections", "complete-installation", connection.id, "--data", "{}"],
    ["credentials", "rollback-rotation", credential.id, "--idempotency-key", "key"],
    ["wallets", "request-faucet", "cwlt_example", "--data", '{"amount":"1"}'],
    ["fireblocks", "csr", "create", "--data", '{"privateKeyPem":"no"}', "--idempotency-key", "key"],
    ["connections", "list", "--provider", "unknown"],
    [
      "credentials",
      "submit",
      "--provider",
      "privy",
      "--fields",
      JSON.stringify(privySetup.fields),
      "--data",
      JSON.stringify(privySetup),
      "--idempotency-key",
      "key",
    ],
  ];
  for (const args of invalid) {
    const result = await invoke(["custody", ...args]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(!result.stderr.includes(secret));
  }
});
test("submitted provider secrets are redacted in raw, URL-encoded and JSON-escaped structured errors", async () => {
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  const reply = Response.json(
    {
      error: {
        code: "CONFLICT",
        message: forms.join(" | "),
        details: { [secret]: forms, nested: { value: secret }, connectionId: connection.id },
      },
      meta,
    },
    { status: 409 }
  );
  const result = await invoke(
    [
      "custody",
      "credentials",
      "submit",
      "--data",
      JSON.stringify(privySetup),
      "--idempotency-key",
      "key",
    ],
    reply
  );
  assert.equal(result.code, 1);
  for (const value of forms) assert(!result.stderr.includes(value));
  assert(result.stderr.includes("[REDACTED]"));
  assert.equal(JSON.parse(result.stderr).error.details.connectionId, connection.id);
  const discoveryError = await invoke(
    [
      "custody",
      "fireblocks",
      "vaults",
      "discover",
      "--data",
      JSON.stringify({ ...discovery, apiKey: ` ${apiUserId} ` }),
    ],
    Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: apiUserId,
          details: { value: encodeURIComponent(apiUserId) },
        },
        meta,
      },
      { status: 400 }
    )
  );
  assert.equal(discoveryError.code, 1);
  assert(!discoveryError.stderr.includes(apiUserId));
  assert(!discoveryError.stderr.includes(encodeURIComponent(apiUserId)));
});
test("unexpected plaintext response fields and malformed lifecycle results emit no output", async () => {
  const replies = [
    response(
      { providerCredential: { ...credential, appSecret: secret }, connectionId: connection.id },
      201
    ),
    response(
      { providerCredential: credential, connectionId: connection.id, appSecret: secret },
      201
    ),
    response(
      {
        providerCredential: {
          ...credential,
          displayMetadata: { privateKeyPem: "unexpected-private-key" },
        },
        connectionId: connection.id,
      },
      201
    ),
    response({}),
    response({ providerCredential: credential, connectionId: connection.id }, 200),
  ];
  for (const reply of replies) {
    const result = await invoke(
      [
        "custody",
        "credentials",
        "submit",
        "--data",
        JSON.stringify(privySetup),
        "--idempotency-key",
        "key",
      ],
      reply
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert(!result.stderr.includes(secret));
  }
});
test("authorization, release, audit, quota and uncertain failures never trigger recovery or retry", async () => {
  for (const [status, code] of [
    [403, "INSUFFICIENT_PERMISSIONS"],
    [403, "FORBIDDEN"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    const details = { reason: "operator_action_required", credentialId: credential.id },
      result = await invoke(
        ["custody", "credentials", "complete-rotation", credential.id],
        error(status, code, details)
      );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stderr).error.details, details);
  }
});
