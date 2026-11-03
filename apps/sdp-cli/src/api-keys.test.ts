import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { operationById } from "./contract";
import { runCli } from "./run";

const session = {
  SDP_TOKEN: "key-admin-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const meta = { requestId: "req_api_keys", timestamp: "2026-01-01T00:00:00.000Z" };
const listItem = {
  id: "key_example",
  name: "Automation",
  keyPrefix: "sf_fixture",
  grants: ["wallets.read"],
  environment: "sandbox",
  status: "active",
  walletScope: "selected",
  walletIds: ["cwlt_example"],
  lastUsedAt: null,
  expiresAt: null,
  rotationDeadline: null,
  createdAt: meta.timestamp,
};
const details = {
  ...listItem,
  description: null,
  projectId: session.SDP_PROJECT_ID,
  allowedIps: null,
  rotatedFrom: null,
};
const secret = "fixture-key-delivered-once";
const created = {
  id: "key_new",
  name: "Automation",
  key: secret,
  keyPrefix: "sf_new",
  grants: ["wallets.read"],
  environment: "sandbox",
  expiresAt: null,
  createdAt: meta.timestamp,
};
const rotation = {
  apiKey: created,
  previousKey: { id: listItem.id, rotationDeadline: "2026-01-02T00:00:00.000Z" },
};
const createArgs = [
  "api-keys",
  "create",
  "--name",
  "Automation",
  "--grant",
  "wallets.read",
  "--wallet-scope",
  "selected",
];
const allCommands = [
  ["api-keys", "list"],
  ["api-keys", "get", listItem.id],
  createArgs,
  ["api-keys", "update", listItem.id, "--name", "Updated"],
  ["api-keys", "rotate", listItem.id],
  ["api-keys", "revoke", listItem.id, "--confirmation", listItem.name],
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
function createdResponse(): Response {
  return Response.json({ data: { apiKey: created }, meta }, { status: 201 });
}
function rotationResponse(): Response {
  return Response.json({ data: rotation, meta }, { status: 201 });
}
function updatedResponse(): Response {
  return Response.json({ data: { success: true }, meta });
}
function revokedResponse(
  recurringPayments: { canceled: string[]; failed: string[] } | null
): Response {
  return Response.json({
    data: { success: true, revokedAt: meta.timestamp, recurringPayments },
    meta,
  });
}
function headers(request: RecordedRequest): Headers {
  return new Headers(request.init.headers);
}

// CLI operation coverage is also checked globally against the generated contract.
test("API-key help describes project scope, one-time secrets, and revocation", async () => {
  for (const args of [
    ["api-keys"],
    ...allCommands.map((command) => [...command.slice(0, 2), "--help"]),
  ]) {
    const result = await invoke(args, updatedResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[1] === "create" || args[1] === "rotate")
      assert(result.stdout.includes("printed to stdout once"));
    if (args[1] === "revoke") assert(result.stdout.includes("--confirmation"));
  }
});

test("all six API-key operations require a session and a selected project", async () => {
  for (const args of allCommands) {
    const noProject = await invoke(args, updatedResponse(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(noProject.code, 2, noProject.stderr);
    assert.equal(noProject.requests.length, 0);
    assert(noProject.stderr.includes("--project"));
    const apiKeyAuth = await invoke(args, updatedResponse(), {
      env: { SDP_API_KEY: "fixture-key", SDP_PROJECT_ID: session.SDP_PROJECT_ID },
    });
    assert.equal(apiKeyAuth.code, 2, apiKeyAuth.stderr);
    assert.equal(apiKeyAuth.requests.length, 0);
    assert(apiKeyAuth.stderr.includes("Clerk session"));
  }
});

test("lists the selected project's key summaries without retrieving secrets", async () => {
  const result = await invoke(
    ["api-keys", "list", "--project", "prj_selected"],
    Response.json({ data: { apiKeys: [listItem] }, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/api-keys");
  assert.equal(headers(result.requests[0]).get("x-project-id"), "prj_selected");
  assert.deepEqual(JSON.parse(result.stdout), { data: { apiKeys: [listItem] }, meta });
  assert(!result.stdout.includes(secret));
  assert.equal(result.requests.length, 1);
});

test("gets key details by ID in the selected project", async () => {
  const result = await invoke(
    ["api-keys", "get", listItem.id],
    Response.json({ data: details, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, `http://localhost:8787/v1/api-keys/${listItem.id}`);
  assert.equal(headers(result.requests[0]).get("authorization"), `Bearer ${session.SDP_TOKEN}`);
  assert.deepEqual(JSON.parse(result.stdout).data, details);
  assert(!result.stdout.includes(secret));
});

test("key IDs stay within one URL segment", async () => {
  const result = await invoke(
    ["api-keys", "get", "key_/with?#"],
    Response.json({ data: details, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/api-keys/key_%2Fwith%3F%23");
});

test("creates a key with explicit grants, signing wallets, allowlist, and expiration", async () => {
  const result = await invoke(
    [
      ...createArgs,
      "--description",
      "Service key",
      "--grant",
      "projects.read",
      "--wallet-id",
      "cwlt_one",
      "--wallet-id",
      "cwlt_two",
      "--allowed-ip",
      "203.0.113.0/24",
      "--allowed-ip",
      "2001:db8::/32",
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
    ],
    createdResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    name: "Automation",
    description: "Service key",
    grants: ["wallets.read", "projects.read"],
    walletScope: "selected",
    walletIds: ["cwlt_one", "cwlt_two"],
    allowedIps: ["203.0.113.0/24", "2001:db8::/32"],
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(JSON.parse(result.stdout).data.apiKey.key, secret);
  assert.equal(result.stdout.split(secret).length - 1, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
});

test("creation supports JSON files, stdin and an explicitly empty grant list", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-cli-key-"));
  try {
    const file = path.join(directory, "key.json");
    const body = JSON.stringify({ name: "Automation", grants: [], walletScope: "all" });
    await writeFile(file, body);
    for (const source of [body, `@${file}`, "-"]) {
      const result = await invoke(["api-keys", "create", "--data", source], createdResponse(), {
        stdin: body,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.requests[0].init.body, body);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates a key using only the fields supplied by the caller", async () => {
  const result = await invoke(
    [
      "api-keys",
      "update",
      listItem.id,
      "--name",
      "Updated",
      "--grant",
      "projects.read",
      "--wallet-scope",
      "selected",
      "--wallet-id",
      "cwlt_new",
      "--allowed-ip",
      "203.0.113.1",
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
    ],
    updatedResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    name: "Updated",
    grants: ["projects.read"],
    walletScope: "selected",
    walletIds: ["cwlt_new"],
    allowedIps: ["203.0.113.1"],
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  const rename = await invoke(
    ["api-keys", "update", listItem.id, "--name", "Renamed"],
    updatedResponse()
  );
  assert.equal(rename.code, 0, rename.stderr);
  assert.deepEqual(JSON.parse(String(rename.requests[0].init.body)), { name: "Renamed" });
});

test("update clearing flags send explicit nulls and empty grants", async () => {
  const result = await invoke(
    [
      "api-keys",
      "update",
      listItem.id,
      "--clear-description",
      "--clear-allowed-ips",
      "--clear-expiration",
      "--clear-grants",
    ],
    updatedResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    description: null,
    allowedIps: null,
    expiresAt: null,
    grants: [],
  });
});

test("JSON updates preserve nulls and empty wallet or grant arrays", async () => {
  const body = {
    description: null,
    allowedIps: null,
    expiresAt: null,
    grants: [],
    walletScope: "selected",
    walletIds: [],
  };
  const result = await invoke(
    ["api-keys", "update", listItem.id, "--data", "-"],
    updatedResponse(),
    { stdin: JSON.stringify(body) }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), body);
});

test("rotation without body flags leaves the grace period to the server", async () => {
  const result = await invoke(["api-keys", "rotate", listItem.id], rotationResponse());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, `http://localhost:8787/v1/api-keys/${listItem.id}/rotate`);
  assert.equal(result.requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {});
  assert.deepEqual(JSON.parse(result.stdout).data, rotation);
  assert.equal(result.stdout.split(secret).length - 1, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
});

test("rotation preserves zero, fractional, and maximum grace periods", async () => {
  for (const hours of [0, 0.5, 168]) {
    const result = await invoke(
      ["api-keys", "rotate", listItem.id, "--grace-period-hours", String(hours)],
      rotationResponse()
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { gracePeriodHours: hours });
  }
  const json = await invoke(
    ["api-keys", "rotate", listItem.id, "--data", '{"gracePeriodHours":0}'],
    rotationResponse()
  );
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(String(json.requests[0].init.body)), { gracePeriodHours: 0 });
});

test("revocation sends the exact name confirmation without opting into recurring cancellation", async () => {
  const result = await invoke(
    ["api-keys", "revoke", listItem.id, "--confirmation", "Primary Service Key"],
    revokedResponse(null)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    confirmation: "Primary Service Key",
  });
  assert.deepEqual(JSON.parse(result.stdout).data, {
    success: true,
    revokedAt: meta.timestamp,
    recurringPayments: null,
  });
});

test("revocation preserves both canceled and failed recurring-payment IDs", async () => {
  const recurringPayments = { canceled: ["rec_canceled"], failed: ["rec_failed"] };
  const result = await invoke(
    [
      "api-keys",
      "revoke",
      listItem.id,
      "--confirmation",
      listItem.name,
      "--cancel-recurring-payments",
    ],
    revokedResponse(recurringPayments)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), {
    confirmation: listItem.name,
    cancelRecurringPayments: true,
  });
  assert.deepEqual(JSON.parse(result.stdout).data.recurringPayments, recurringPayments);
  const body = { confirmation: listItem.name, cancelRecurringPayments: false };
  const json = await invoke(
    ["api-keys", "revoke", listItem.id, "--data", JSON.stringify(body)],
    revokedResponse(null)
  );
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(String(json.requests[0].init.body)), body);
});

test("invalid key arguments and conflicting field updates make no requests", async () => {
  const cases = [
    ["api-keys", "get"],
    ["api-keys", "get", ".."],
    ["api-keys", "list", "--page", "1"],
    ["api-keys", "create", "--name", "Automation", "--wallet-scope", "all"],
    [
      "api-keys",
      "create",
      "--name",
      "Automation",
      "--grant",
      "api_keys.manage",
      "--wallet-scope",
      "selected",
    ],
    [
      "api-keys",
      "create",
      "--data",
      '{"name":"Key","role":"admin","grants":[],"walletScope":"all"}',
    ],
    [
      "api-keys",
      "create",
      "--data",
      '{"name":"Key","grants":[],"walletScope":"all","provisionWallet":true}',
    ],
    ["api-keys", "update", listItem.id],
    ["api-keys", "update", listItem.id, "--data", "{}"],
    ["api-keys", "update", listItem.id, "--description", "Text", "--clear-description"],
    ["api-keys", "update", listItem.id, "--allowed-ip", "203.0.113.1", "--clear-allowed-ips"],
    [
      "api-keys",
      "update",
      listItem.id,
      "--expires-at",
      "2027-01-01T00:00:00.000Z",
      "--clear-expiration",
    ],
    ["api-keys", "update", listItem.id, "--grant", "wallets.read", "--clear-grants"],
    ["api-keys", "update", listItem.id, "--wallet-scope", "unknown"],
    ["api-keys", "update", listItem.id, "--data", '{"expiresAt":"invalid"}'],
    ["api-keys", "update", listItem.id, "--name", "Renamed", "--data", '{"description":null}'],
    ["api-keys", "rotate", listItem.id, "--grace-period-hours", "-1"],
    ["api-keys", "rotate", listItem.id, "--grace-period-hours", "169"],
    ["api-keys", "rotate", listItem.id, "--grace-period-hours", "NaN"],
    ["api-keys", "rotate", listItem.id, "--data", '{"gracePeriodHours":null}'],
    ["api-keys", "rotate", listItem.id, "--grace-period-hours", "0", "--data", "{}"],
    ["api-keys", "revoke", listItem.id],
    ["api-keys", "revoke", listItem.id, "--confirmation", ""],
    [
      "api-keys",
      "revoke",
      listItem.id,
      "--data",
      '{"confirmation":"Automation","cancelRecurringPayments":"true"}',
    ],
  ];
  for (const args of cases) {
    const result = await invoke(args, updatedResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("no API-key command offers an unsupported idempotency flag", async () => {
  for (const args of allCommands) {
    const result = await invoke([...args, "--idempotency-key", "unsupported"], updatedResponse());
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  for (const operation of ["createApiKey", "createProjectApiKey", "rotateApiKey"])
    assert.equal(operationById(operation).returnsApiKeySecret, true);
  for (const operation of ["listApiKeys", "getApiKey", "updateApiKey", "revokeApiKey"])
    assert.equal(operationById(operation).returnsApiKeySecret, false);
});

test("creation and rotation failures do not retry or leak session credentials", async () => {
  for (const args of [createArgs, ["api-keys", "rotate", listItem.id]]) {
    for (const failure of [
      new Error("sensitive upstream details"),
      new DOMException("sensitive upstream details", "TimeoutError"),
    ]) {
      const result = await invoke(args, rotationResponse(), { failure });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.requests.length, 1);
      assert.equal(result.stdout, "");
      assert(!result.stderr.includes("sensitive"));
      assert(!result.stderr.includes(session.SDP_TOKEN));
    }
    const conflict = await invoke(
      args,
      Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "The key was already rotated; replacement is key_new",
          },
          meta,
        },
        { status: 409 }
      )
    );
    assert.equal(conflict.code, 1);
    assert.equal(conflict.requests.length, 1);
    assert.equal(JSON.parse(conflict.stderr).error.requestId, meta.requestId);
  }
});

test("revocation permission and name-confirmation errors preserve the API response", async () => {
  for (const status of [400, 403, 404]) {
    const result = await invoke(
      ["api-keys", "revoke", listItem.id, "--confirmation", "Wrong name"],
      Response.json(
        { error: { code: "REFUSED", message: "Key cannot be deactivated" }, meta },
        { status }
      )
    );
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.status, status);
    assert.equal(result.requests.length, 1);
  }
});
