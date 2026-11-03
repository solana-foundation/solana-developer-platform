import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { type JsonObject, operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_screening", timestamp: "2026-10-29T00:00:00.000Z" };
const apiKey = { SDP_API_KEY: "screening-key", SDP_API_URL: "http://localhost:8787" };
const session = {
  SDP_TOKEN: "screening-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: apiKey.SDP_API_URL,
};
const command = ["compliance", "screen-address"];
const screening: JsonObject & { providers: JsonObject[] } = {
  address: SOL_MINT,
  network: "solana",
  intent: "unknown",
  checkedAt: meta.timestamp,
  providers: [
    {
      provider: "range",
      status: "ok",
      riskScore: 0,
      riskLevel: "Low",
      evaluatedAt: meta.timestamp,
    },
    {
      provider: "elliptic",
      status: "pending",
      riskScore: null,
      providerStatus: "PENDING",
      evaluatedAt: meta.timestamp,
    },
    {
      provider: "trm",
      status: "unavailable",
      riskScore: null,
      message: "Provider unavailable",
      evaluatedAt: meta.timestamp,
    },
    {
      provider: "chainalysis",
      status: "error",
      riskScore: null,
      message: "Provider check failed",
      evaluatedAt: meta.timestamp,
    },
  ],
};
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  options: { reply?: Response; env?: NodeJS.ProcessEnv; stdin?: string; failure?: Error } = {}
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
      return options.reply ?? response({ screening });
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
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}

test("compliance help works offline and documents its execute grant and optional key", async () => {
  for (const args of [["compliance"], [...command, "--help"]]) {
    const result = await invoke(args, { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("screen-address"));
  }
  const help = await invoke([...command, "--help"], { env: {} });
  assert(help.stdout.includes("compliance.execute"));
  assert(help.stdout.includes("--idempotency-key"));
  const operation = operationById("screenComplianceAddress");
  assert.equal(operation.method, "POST");
  assert.equal(operation.path, "/v1/compliance/address-screenings");
  assert.equal(operation.sessionOnly, false);
  assert.deepEqual(operation.authorization, { kind: "action", action: "compliance.execute" });
  assert.equal(operation.parameters.find((p) => p.name === "Idempotency-Key")?.required, false);
});
test("named screening flags send one scoped request with the explicit retry key", async () => {
  const result = await invoke(
    [
      ...command,
      "--address",
      SOL_MINT,
      "--network",
      "solana",
      "--intent",
      "transfer_destination",
      "--idempotency-key",
      "screening-42",
    ],
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0],
    headers = new Headers(request.init.headers);
  assert.equal(request.url, "http://localhost:8787/v1/compliance/address-screenings");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(body(request), {
    address: SOL_MINT,
    network: "solana",
    intent: "transfer_destination",
  });
  assert.equal(headers.get("authorization"), "Bearer screening-session");
  assert.equal(headers.get("x-project-id"), session.SDP_PROJECT_ID);
  assert.equal(headers.get("idempotency-key"), "screening-42");
});
test("omitted network, intent, and key remain server-owned defaults", async () => {
  const result = await invoke([...command, "--address", SOL_MINT]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { address: SOL_MINT });
  const headers = new Headers(result.requests[0].init.headers);
  assert.equal(headers.get("idempotency-key"), null);
  assert.equal(headers.get("x-project-id"), null);
  assert.equal(headers.get("authorization"), "Bearer screening-key");
});
test("every supported intent is passed through without changing provider results", async () => {
  for (const intent of ["transfer_destination", "wallet_address_addition", "unknown"]) {
    const result = await invoke([...command, "--address", SOL_MINT, "--intent", intent], {
      reply: response({ screening: { ...screening, intent } }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(body(result.requests[0]).intent, intent);
    assert.equal(JSON.parse(result.stdout).data.screening.intent, intent);
  }
});
test("screening preserves partial provider outcomes, null scores, zero scores, and audit status words", async () => {
  const result = await invoke([...command, "--address", SOL_MINT, "--compact"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${JSON.stringify({ data: { screening }, meta })}\n`);
  assert.equal(result.requests.length, 1);
  const providerWord = {
    provider: "chainalysis",
    status: "ok",
    riskScore: null,
    riskLevel: "Medium",
    providerStatus: "COMPLETE",
    evaluatedAt: meta.timestamp,
  };
  const observed = await invoke([...command, "--address", SOL_MINT], {
    reply: response({ screening: { ...screening, providers: [providerWord] } }),
  });
  assert.equal(observed.code, 0, observed.stderr);
  assert.deepEqual(JSON.parse(observed.stdout).data.screening.providers, [providerWord]);
});
test("complete JSON bodies support inline, file, and stdin inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-compliance-input-"));
  try {
    const input = { address: SOL_MINT, network: "solana", intent: "wallet_address_addition" },
      encoded = JSON.stringify(input),
      file = path.join(directory, "screening.json");
    await writeFile(file, encoded);
    for (const source of [encoded, `@${file}`, "-"]) {
      const result = await invoke([...command, "--data", source], { stdin: encoded });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), input);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("missing, mistyped, unknown, and out-of-scope inputs fail before fetch", async () => {
  const invalid: string[][] = [
    [],
    ["--address", ""],
    ["--address", SOL_MINT, "--intent", "payment"],
    ["--address", SOL_MINT, "--network", "x".repeat(65)],
    ["--data", JSON.stringify({ address: 1 })],
    ["--data", JSON.stringify({ address: SOL_MINT, network: 1 })],
    ["--data", JSON.stringify({ address: SOL_MINT, providers: ["range"] })],
    ["--address", SOL_MINT, "--provider", "range"],
    ["--address", SOL_MINT, "--idempotency-key", ""],
    ["--address", SOL_MINT, "--data", JSON.stringify({ address: SOL_MINT })],
    ["--address", SOL_MINT, "unexpected-id"],
  ];
  for (const args of invalid) {
    const result = await invoke([...command, ...args]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("screening requires an account credential and a project for member sessions", async () => {
  for (const env of [{}, { SDP_TOKEN: session.SDP_TOKEN }]) {
    const result = await invoke([...command, "--address", SOL_MINT], { env });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("the API owns network normalization and chain-specific address validation", async () => {
  const address = "0xExampleAddress",
    network = " Ethereum ";
  const result = await invoke([...command, "--address", address, "--network", network], {
    reply: response({ screening: { ...screening, address, network: "ethereum" } }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { address, network });
  assert.equal(JSON.parse(result.stdout).data.screening.network, "ethereum");
  const refused = await invoke([...command, "--address", "invalid-solana-address"], {
    reply: Response.json(
      { error: { code: "BAD_REQUEST", message: "Invalid Solana address" }, meta },
      { status: 400 }
    ),
  });
  assert.equal(refused.code, 1);
  assert.equal(refused.requests.length, 1);
  assert.equal(JSON.parse(refused.stderr).error.code, "BAD_REQUEST");
});
test("permission, entitlement, quota, replay, and provider failures remain single structured errors", async () => {
  for (const [status, code, reason] of [
    [403, "INSUFFICIENT_PERMISSIONS", "compliance.execute"],
    [403, "FORBIDDEN", "provider_not_entitled"],
    [409, "IDEMPOTENCY_KEY_IN_FLIGHT", "in_flight"],
    [422, "IDEMPOTENCY_KEY_REUSED", "changed_body"],
    [429, "RATE_LIMITED", "quota_exhausted"],
    [503, "PROVIDER_NOT_CONFIGURED", "credentials_missing"],
  ] as const) {
    const details = { reason },
      reply = Response.json(
        { error: { code, message: "Screening refused", details }, meta },
        { status }
      );
    const result = await invoke(
      [...command, "--address", SOL_MINT, "--idempotency-key", "screening-42"],
      { reply }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stderr).error.details, details);
  }
  const failed = await invoke([...command, "--address", SOL_MINT], {
    failure: new Error(`connection failed ${apiKey.SDP_API_KEY}`),
  });
  assert.equal(failed.code, 1);
  assert.equal(failed.requests.length, 1);
  assert(!failed.stderr.includes(apiKey.SDP_API_KEY));
});
test("malformed results and undeclared success statuses emit no partial screening", async () => {
  const invalid: JsonObject[] = [
    {},
    { screening: { ...screening, intent: "unsupported" } },
    { screening: { ...screening, checkedAt: "yesterday" } },
    { screening: { ...screening, providers: [{ ...screening.providers[0], riskScore: "0" }] } },
    { screening: { ...screening, providers: [{ ...screening.providers[0], status: "complete" }] } },
  ];
  for (const reply of [...invalid.map((data) => response(data)), response({ screening }, 201)]) {
    const result = await invoke([...command, "--address", SOL_MINT], { reply });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
