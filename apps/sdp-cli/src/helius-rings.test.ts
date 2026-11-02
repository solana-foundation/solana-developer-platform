import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HELIUS_RINGS_OPERATION_STATUSES } from "@sdp/types/helius-rings";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Command } from "./commands";
import { type JsonObject, operationById } from "./contract";
import { heliusRingsCommands } from "./helius-rings-commands";
import { runCli } from "./run";

const meta = { requestId: "req_rings", timestamp: "2026-10-29T00:00:00.000Z" };
const apiKey = { SDP_API_KEY: "rings-key", SDP_API_URL: "http://localhost:8787" };
const session = {
  SDP_TOKEN: "rings-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: apiKey.SDP_API_URL,
};
const amountRaw = "18446744073709551615";
const wallet = {
  id: "hrw_example",
  sdpWalletId: "provider_wallet",
  name: "Treasury",
  shieldedAddress: "shielded:fixture",
  status: "ready",
  network: "devnet",
  syncCursor: null,
  materialTag: "live",
};
const input = {
  walletId: wallet.id,
  opType: "shield",
  asset: { mint: SOL_MINT, amountRaw },
  clientNonce: "explicit-intent-42",
};
const operation = {
  id: "hrop_example",
  walletId: wallet.id,
  opType: input.opType,
  state: "indexing",
  proof: null,
  outerTxSignature: "submitted_signature",
  photonIndexedAt: null,
  failure: null,
  ringProgramId: null,
  input: { ...input, clientNonce: "" },
  intentKey: "intent_fingerprint",
  events: [],
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
  retryOfOperationId: null,
};
const summary = {
  id: operation.id,
  walletId: wallet.id,
  opType: input.opType,
  state: "indexing",
  assetMint: SOL_MINT,
  amountRaw,
  ringProgramId: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
  failureCode: null,
  outerTxSignature: operation.outerTxSignature,
  retryable: null,
  retryOfOperationId: null,
};
const ring = {
  id: "hrr_example",
  name: "treasury",
  ringProgramId: SOL_MINT,
  status: "active",
  auditorPublicKeyHex: null,
  lookupTableAddress: null,
  failure: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
};
const connection = {
  id: "hrconn_example",
  name: "Fixture endpoints",
  network: "devnet",
  status: "active",
  isDefault: true,
  allowInsecureHttp: false,
  endpoints: {
    rpc: "https://rpc.example",
    indexer: "https://photon.example",
    prover: "https://prover.example",
    ringRpc: null,
  },
  lastCheckStatus: null,
  lastCheckAt: null,
  lastCheckFailureCode: null,
  createdAt: meta.timestamp,
};
const connectionInput = {
  name: connection.name,
  solanaRpcUrl: "https://rpc.example/api?api-key=fixture",
  indexerUrl: "https://photon.example/api?api-key=fixture",
  proverUrl: "https://prover.example",
};
const health = { rpc: "green", prover: "amber", photon: "red", detail: { photon: "unavailable" } };
const bodySamples: Record<string, JsonObject> = {
  createHeliusRingsProjectRing: { name: ring.name, ringProgramId: ring.ringProgramId },
  createHeliusRingsWallet: { walletId: "cwlt_example", name: wallet.name },
  rekeyHeliusRingsWallet: { confirmation: wallet.name },
  createHeliusRingsZone: { name: "Ops", kind: "treasury" },
  createHeliusRingsOperation: input,
  retryHeliusRingsOperation: { clientNonce: "explicit-retry-42" },
  voidHeliusRingsOperation: { signature: operation.outerTxSignature },
  createHeliusRingsConnection: connectionInput,
};
const pathValues: Record<string, string> = {
  walletId: "wallet/example?#",
  operationId: "operation/example?#",
  connectionId: "connection/example?#",
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
    env: options.env ?? apiKey,
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
        message: "Rings operation refused",
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
  const op = operationById(command.operationId),
    args = [...command.words];
  for (const parameter of op.parameters.filter((p) => p.location === "path")) {
    assert(pathValues[parameter.name]);
    args.push(pathValues[parameter.name]);
  }
  if (op.body !== null) {
    assert(bodySamples[command.operationId], command.operationId);
    args.push("--data", JSON.stringify(bodySamples[command.operationId]));
  }
  return args;
}

test("all 24 Helius Rings commands provide offline scoped help", async () => {
  assert.equal(heliusRingsCommands.length, 24);
  for (const args of [
    ["helius-rings"],
    ...heliusRingsCommands.map((command) => [...command.words, "--help"]),
  ]) {
    const result = await invoke(args, error(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
  }
  const help = await invoke(["helius-rings", "operations", "execute", "--help"], error(), {
    env: {},
  });
  assert(help.stdout.includes("pipeline immediately"));
  assert(help.stdout.includes("clientNonce"));
  assert(!help.stdout.includes("--idempotency-key"));
});
test("all operations use their generated route, method, encoded IDs, and exact body", async () => {
  for (const command of heliusRingsCommands) {
    const op = operationById(command.operationId),
      result = await invoke(argsFor(command), error(), { env: session });
    assert.equal(result.code, 1, `${command.operationId}: ${result.stderr}`);
    assert.equal(result.requests.length, 1, command.operationId);
    const request = result.requests[0];
    let pathname = op.path;
    for (const p of op.parameters.filter((p) => p.location === "path"))
      pathname = pathname.replace(`{${p.name}}`, encodeURIComponent(pathValues[p.name]));
    assert.equal(new URL(request.url).pathname, pathname);
    assert.equal(request.init.method, op.method);
    assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer rings-session");
    assert.equal(new Headers(request.init.headers).get("x-project-id"), session.SDP_PROJECT_ID);
    assert.equal(new Headers(request.init.headers).get("idempotency-key"), null);
    if (op.body === null) assert.equal(request.init.body, undefined);
    else assert.deepEqual(body(request), bodySamples[command.operationId]);
  }
});
test("connection administration is session-only and every session command selects a project", async () => {
  for (const command of heliusRingsCommands) {
    const op = operationById(command.operationId);
    assert.equal(op.sessionOnly, command.words[1] === "connections");
    if (op.sessionOnly) {
      assert.deepEqual(op.authorization, { kind: "action", action: "helius_rings.configure" });
      const result = await invoke(argsFor(command));
      assert.equal(result.code, 2);
      assert.equal(result.requests.length, 0);
    }
    const result = await invoke(argsFor(command), error(), {
      env: { SDP_TOKEN: session.SDP_TOKEN },
    });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("API keys can call the 19 project operations without tenant headers", async () => {
  for (const command of heliusRingsCommands.filter(
    (c) => !operationById(c.operationId).sessionOnly
  )) {
    const result = await invoke(argsFor(command));
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(new Headers(result.requests[0].init.headers).get("x-project-id"), null);
  }
});
test("setup and health retain missing configuration and degraded component observations", async () => {
  const data = {
    configured: false,
    source: "none",
    canManage: false,
    allowInsecureHttpAllowed: false,
    defaultConnection: null,
  };
  const setup = await invoke(["helius-rings", "setup-status"], response(data));
  assert.equal(setup.code, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout).data, data);
  const ready = await invoke(
    ["helius-rings", "setup-status"],
    response({
      configured: true,
      source: "database",
      canManage: true,
      allowInsecureHttpAllowed: false,
      defaultConnection: connection,
    })
  );
  assert.equal(ready.code, 0, ready.stderr);
  const result = await invoke(["helius-rings", "health"], response({ health }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.health, health);
  assert.equal(result.requests.length, 1);
});
test("custom ring bring-up and list preserve failure or incomplete observations", async () => {
  const failed = {
    ...ring,
    status: "failed",
    failure: { code: "gateway_unavailable", message: "retry bring-up explicitly" },
  };
  const created = await invoke(
    [
      "helius-rings",
      "rings",
      "register-and-initialize",
      "--name",
      ring.name,
      "--ring-program-id",
      SOL_MINT,
    ],
    response({ ring: failed }, 201)
  );
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(body(created.requests[0]), { name: ring.name, ringProgramId: SOL_MINT });
  assert.deepEqual(JSON.parse(created.stdout).data.ring, failed);
  const listed = await invoke(
    ["helius-rings", "rings", "list"],
    response({ rings: [ring, failed] })
  );
  assert.equal(listed.code, 0, listed.stderr);
});
test("custody provisioning uses its custody ID and later paths use the Rings wallet ID", async () => {
  const created = await invoke(
    [
      "helius-rings",
      "wallets",
      "provision-identity",
      "--custody-wallet-id",
      "cwlt_example",
      "--name",
      wallet.name,
    ],
    response({ wallet }, 201)
  );
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(body(created.requests[0]), { walletId: "cwlt_example", name: wallet.name });
  assert.equal(JSON.parse(created.stdout).data.wallet.sdpWalletId, wallet.sdpWalletId);
  const got = await invoke(
    ["helius-rings", "wallets", "get", wallet.id],
    response({ wallet: { ...wallet, status: "paused" } })
  );
  assert.equal(got.code, 0, got.stderr);
  assert(new URL(got.requests[0].url).pathname.endsWith(wallet.id));
});
test("sync keeps unknown precision, unpriced balances, ring separation, and degraded state", async () => {
  const balances: JsonObject[] = [
    { mint: SOL_MINT, symbol: "SOL", amountRaw, decimals: null, ringProgramId: null, noteCount: 0 },
    {
      mint: SOL_MINT,
      symbol: "SOL",
      amountRaw: "0",
      decimals: 9,
      ringProgramId: SOL_MINT,
      noteCount: 2,
      usdPrice: 0,
      usdValue: 0,
    },
  ];
  const data = { balances, totalUsd: null, degraded: true, observedAt: meta.timestamp };
  const result = await invoke(["helius-rings", "wallets", "sync", wallet.id], response(data));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
  assert.equal(result.requests[0].init.body, undefined);
  assert.equal(result.requests.length, 1);
});
test("identity inspections never trigger rekey and rekey requires the explicit typed confirmation", async () => {
  const identity = {
    status: "foreign",
    derivedShieldedAddress: "derived:fixture",
    publishedShieldedAddress: "published:fixture",
    mismatch: "viewing_key",
    recordedShieldedAddress: null,
  };
  const read = await invoke(
    ["helius-rings", "wallets", "identity", "get", wallet.id],
    response({ identity })
  );
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.requests.length, 1);
  assert.deepEqual(JSON.parse(read.stdout).data.identity, identity);
  const missing = await invoke(["helius-rings", "wallets", "identity", "rekey", wallet.id]);
  assert.equal(missing.code, 2);
  assert.equal(missing.requests.length, 0);
  const rekey = await invoke(
    ["helius-rings", "wallets", "identity", "rekey", wallet.id, "--confirmation", wallet.name],
    response({ wallet })
  );
  assert.equal(rekey.code, 0, rekey.stderr);
  assert.deepEqual(body(rekey.requests[0]), { confirmation: wallet.name });
});
test("zones return their actual metadata-only create and list envelopes", async () => {
  const zone = { id: "hrz_example", name: "Ops", kind: "treasury" };
  const created = await invoke(
    [
      "helius-rings",
      "wallets",
      "zones",
      "create",
      wallet.id,
      "--name",
      zone.name,
      "--kind",
      zone.kind,
    ],
    response({ zone }, 201)
  );
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(body(created.requests[0]), { name: zone.name, kind: zone.kind });
  const listed = await invoke(
    ["helius-rings", "wallets", "zones", "list", wallet.id],
    response({ zones: [zone] })
  );
  assert.equal(listed.code, 0, listed.stderr);
});
test("all six enabled flows preserve their distinct terms and u64 strings", async () => {
  const flows: JsonObject[] = [
    input,
    { ...input, opType: "withdraw", to: SOL_MINT },
    { ...input, opType: "transfer_registered", to: "shielded:recipient" },
    { ...input, opType: "merge", asset: { mint: SOL_MINT } },
    { ...input, opType: "ring_exit", ring: ring.name },
    { ...input, opType: "ring_entry", ring: ring.name },
  ];
  for (const flow of flows) {
    const result = await invoke(
      ["helius-rings", "operations", "execute", "--data", JSON.stringify(flow)],
      response(
        { operation: { ...operation, opType: flow.opType, input: { ...flow, clientNonce: "" } } },
        201
      )
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), flow);
    assert.equal(result.requests.length, 1);
  }
});
test("named operation flags keep base units and caller nonce without adding defaults", async () => {
  const result = await invoke(
    [
      "helius-rings",
      "operations",
      "execute",
      "--rings-wallet-id",
      wallet.id,
      "--op-type",
      "shield",
      "--mint",
      SOL_MINT,
      "--amount-raw",
      amountRaw,
      "--client-nonce",
      input.clientNonce,
    ],
    response({ operation }, 201)
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), input);
  assert.equal(new URL(result.requests[0].url).search, "");
  const merge = await invoke(
    [
      "helius-rings",
      "operations",
      "execute",
      "--rings-wallet-id",
      wallet.id,
      "--op-type",
      "merge",
      "--mint",
      SOL_MINT,
      "--client-nonce",
      "merge-42",
    ],
    response({ operation }, 201)
  );
  assert.equal(merge.code, 0, merge.stderr);
  assert.deepEqual(body(merge.requests[0]).asset, { mint: SOL_MINT });
});
test("unsupported flows, cross-flow fields, numeric amounts, and missing nonces fail before fetch", async () => {
  const { clientNonce: _nonce, ...withoutNonce } = input;
  const invalid: JsonObject[] = [
    withoutNonce,
    { ...input, opType: "transfer_anonymous" },
    { ...input, opType: "timelock_create" },
    { ...input, asset: { mint: SOL_MINT, amountRaw: 1 } },
    { ...input, asset: { mint: SOL_MINT, amountRaw: "1.5" } },
    { ...input, opType: "merge" },
    { ...input, to: SOL_MINT },
    { ...input, asset: { ...input.asset, typo: true } },
    { ...input, opType: "ring_exit" },
  ];
  for (const value of invalid) {
    const result = await invoke([
      "helius-rings",
      "operations",
      "execute",
      "--data",
      JSON.stringify(value),
    ]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("server-owned range, mint admission, and reconciliation refinements remain single errors", async () => {
  const result = await invoke(
    [
      "helius-rings",
      "operations",
      "execute",
      "--data",
      JSON.stringify({ ...input, asset: { mint: SOL_MINT, amountRaw: "0" } }),
    ],
    error(400, "BAD_REQUEST", { field: "amountRaw" })
  );
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(JSON.parse(result.stderr).error.status, 400);
});
test("operation detail preserves lifecycle, event payloads, proof omission, and failure retryability", async () => {
  for (const state of HELIUS_RINGS_OPERATION_STATUSES.filter((s) => s !== "approval_required")) {
    const value = {
      ...operation,
      state,
      failure:
        state === "failed"
          ? { code: "indexing_timeout", message: "Indexing uncertain", retryable: false }
          : null,
      events: [
        {
          kind: "operation.observed",
          createdAt: meta.timestamp,
          payload: { count: 0, uncertain: true, amountRaw },
        },
      ],
    };
    const result = await invoke(
      ["helius-rings", "operations", "get", operation.id],
      response({ operation: value })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data.operation, value);
  }
});
test("execute, recheck, retry, and void stay separate explicit requests", async () => {
  const cases: [string[], JsonObject | null, number][] = [
    [["resume-execution"], null, 200],
    [["recheck-signed-failure"], null, 200],
    [["retry", "--client-nonce", "new-retry-42"], { clientNonce: "new-retry-42" }, 201],
    [
      ["void-signed-failure", "--signature", operation.outerTxSignature],
      { signature: operation.outerTxSignature },
      200,
    ],
  ];
  for (const [args, expected, status] of cases) {
    const result = await invoke(
      ["helius-rings", "operations", args[0], operation.id, ...args.slice(1)],
      response(
        { operation: { ...operation, retryOfOperationId: status === 201 ? operation.id : null } },
        status
      )
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    if (expected === null) assert.equal(result.requests[0].init.body, undefined);
    else assert.deepEqual(body(result.requests[0]), expected);
  }
});
test("wallet and operation lists forward bounded limits once with no detail fetches", async () => {
  for (const family of ["wallets", "operations"]) {
    const result = await invoke(
      ["helius-rings", family, "list", "--limit", "200"],
      response(family === "wallets" ? { wallets: [wallet] } : { operations: [summary] })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).searchParams.get("limit"), "200");
    assert.equal(result.requests.length, 1);
    for (const value of ["0", "201", "1.5"]) {
      const invalid = await invoke(["helius-rings", family, "list", "--limit", value]);
      assert.equal(invalid.code, 2);
      assert.equal(invalid.requests.length, 0);
    }
  }
});
test("connection creation preserves keyed endpoint payloads and explicit false without persisting them locally", async () => {
  const result = await invoke(
    [
      "helius-rings",
      "connections",
      "create",
      "--name",
      connection.name,
      "--solana-rpc-url",
      connectionInput.solanaRpcUrl,
      "--indexer-url",
      connectionInput.indexerUrl,
      "--prover-url",
      connectionInput.proverUrl,
      "--allow-insecure-http",
      "false",
    ],
    response(connection, 201),
    { env: session }
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(body(result.requests[0]), { ...connectionInput, allowInsecureHttp: false });
  assert.deepEqual(JSON.parse(result.stdout).data, connection);
  assert(!result.stdout.includes("api-key=fixture"));
});
test("connection reads and mutations preserve safe display metadata and component test results", async () => {
  const cases: [string[], JsonObject][] = [
    [["list"], { connections: [connection] }],
    [["make-default", connection.id], connection],
    [["deactivate", connection.id], { ...connection, isDefault: false, status: "deactivated" }],
    [["test", connection.id], { health, ringRpc: { status: "red", reason: "rpc_unavailable" } }],
  ];
  for (const [args, data] of cases) {
    const result = await invoke(["helius-rings", "connections", ...args], response(data), {
      env: session,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
    assert.equal(result.requests[0].init.body, undefined);
  }
});
test("file and stdin operation input preserve exact terms and conflict with named body flags", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-rings-input-"));
  try {
    const file = path.join(directory, "operation.json");
    await writeFile(file, JSON.stringify(input));
    for (const source of [`@${file}`, "-"]) {
      const result = await invoke(
        ["helius-rings", "operations", "execute", "--data", source],
        response({ operation }, 201),
        { stdin: JSON.stringify(input) }
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), input);
    }
    const conflict = await invoke([
      "helius-rings",
      "operations",
      "execute",
      "--data",
      JSON.stringify(input),
      "--amount-raw",
      "1",
    ]);
    assert.equal(conflict.code, 2);
    assert.equal(conflict.requests.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("unsupported headers, implicit recovery, and cross-command fields fail locally", async () => {
  for (const args of [
    ["operations", "execute", "--idempotency-key", "intent"],
    ["operations", "execute", "--amount", "1.5"],
    ["operations", "resume-execution", operation.id, "--data", "{}"],
    ["operations", "retry", operation.id],
    ["operations", "void-signed-failure", operation.id],
    ["wallets", "sync", wallet.id, "--confirmation", wallet.name],
    ["connections", "create", "--allow-insecure-http", "yes"],
  ]) {
    const result = await invoke(["helius-rings", ...args], error(), { env: session });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
  }
});
test("feature, permission, connection, and uncertain failures never trigger fallback or retry", async () => {
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [403, "INSUFFICIENT_PERMISSIONS"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [503, "SERVICE_UNAVAILABLE"],
  ] as const) {
    const details = { reason: "operator_action_required", signature: operation.outerTxSignature };
    const result = await invoke(
      ["helius-rings", "operations", "retry", operation.id, "--client-nonce", "explicit-retry-42"],
      error(status, code, details)
    );
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stderr).error.details, details);
  }
  const failed = await invoke(
    ["helius-rings", "operations", "execute", "--data", JSON.stringify(input)],
    error(),
    { failure: new Error(`connection failed ${apiKey.SDP_API_KEY}`) }
  );
  assert.equal(failed.code, 1);
  assert.equal(failed.requests.length, 1);
  assert(!failed.stderr.includes(apiKey.SDP_API_KEY));
});
test("malformed success responses, leaked proof objects, and wrong statuses produce no stdout", async () => {
  for (const reply of [
    response({ operation: { ...operation, proof: { source: "live", ref: "untrusted_artifact" } } }),
    response({ operation: { ...operation, state: "unknown" } }),
    response({}),
    response({ operation }, 201),
  ]) {
    const result = await invoke(["helius-rings", "operations", "get", operation.id], reply);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
