import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type JsonObject, operationById } from "./contract";
import { heliusRingsCommands } from "./helius-rings-commands";
import { runCli } from "./run";

const meta = { requestId: "req_dashboard_rings", timestamp: "2026-10-29T00:00:00.000Z" };
const session = {
  SDP_TOKEN: "setup-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const root = ["helius-rings", "connections"];
const setupCommands = heliusRingsCommands.filter((command) => command.words[1] === "connections");
const keys = {
  rpc: "rpc-credential/$+?",
  indexer: "indexer-credential/+?",
  prover: "prover-credential/+$",
  ringRpc: "ring-credential/+?",
};
function endpoint(host: string, key: string) {
  const url = new URL(`https://${host}/private/provider/path`);
  url.searchParams.set("api-key", key);
  return url.toString();
}
const input = {
  name: "Dashboard connection",
  solanaRpcUrl: endpoint("rpc.example", keys.rpc),
  indexerUrl: endpoint("indexer.example", keys.indexer),
  proverUrl: endpoint("prover.example", keys.prover),
  ringRpcUrl: endpoint("ring.example", keys.ringRpc),
};
const connection = {
  id: "hrconn_example",
  name: input.name,
  network: "devnet",
  status: "active",
  isDefault: true,
  allowInsecureHttp: false,
  endpoints: {
    rpc: "https://rpc.example",
    indexer: "https://indexer.example",
    prover: "https://prover.example",
    ringRpc: "https://ring.example",
  },
  lastCheckStatus: null,
  lastCheckAt: null,
  lastCheckFailureCode: null,
  createdAt: meta.timestamp,
};
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  data: JsonObject = connection,
  options: { reply?: Response; env?: NodeJS.ProcessEnv; stdin?: string } = {}
) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? session,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return (
        options.reply ?? Response.json({ data, meta }, { status: args[2] === "create" ? 201 : 200 })
      );
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
function body(request: RecordedRequest) {
  return JSON.parse(String(request.init.body));
}

test("dashboard Rings setup has exactly five existing command mappings and offline help", async () => {
  assert.deepEqual(
    setupCommands.map((command) => command.words[2]),
    ["list", "create", "test", "make-default", "deactivate"]
  );
  for (const command of setupCommands) {
    const operation = operationById(command.operationId);
    assert(operation.path.startsWith("/internal/dashboard/helius-rings/connections"));
    assert.equal(operation.sessionOnly, true);
    assert.deepEqual(operation.authorization, { kind: "action", action: "helius_rings.configure" });
    const help = await invoke([...command.words, "--help"], {}, { env: {} });
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.requests.length, 0);
    assert(help.stdout.includes("organization administrator"));
  }
});
test("all five setup operations require a member session and selected project before fetch", async () => {
  for (const command of setupCommands) {
    const operation = operationById(command.operationId),
      args = [...command.words];
    if (operation.path.includes("{connectionId}")) args.push(connection.id);
    if (operation.body !== null) args.push("--data", JSON.stringify(input));
    for (const env of [{ SDP_API_KEY: "forbidden-key" }, { SDP_TOKEN: session.SDP_TOKEN }]) {
      const result = await invoke(args, {}, { env });
      assert.equal(result.code, 2);
      assert.equal(result.requests.length, 0);
    }
  }
});
test("creation accepts a complete JSON body from file or stdin without filling optional defaults", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sdp-rings-setup-"));
  try {
    const file = path.join(directory, "connection.json"),
      encoded = JSON.stringify(input);
    await writeFile(file, encoded);
    for (const source of [`@${file}`, "-"]) {
      const result = await invoke([...root, "create", "--data", source], connection, {
        stdin: encoded,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(body(result.requests[0]), input);
      assert.equal(
        new Headers(result.requests[0].init.headers).get("authorization"),
        "Bearer setup-session"
      );
      assert.equal(
        new Headers(result.requests[0].init.headers).get("x-project-id"),
        session.SDP_PROJECT_ID
      );
      assert.equal(new URL(result.requests[0].url).search, "");
      assert.equal(result.requests.length, 1);
      assert(!result.stdout.includes("api-key="));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("explicit false and development HTTP opt-in remain exact caller choices", async () => {
  for (const allowInsecureHttp of [false, true]) {
    const data = { ...input, allowInsecureHttp },
      result = await invoke([...root, "create", "--data", JSON.stringify(data)], connection);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(body(result.requests[0]), data);
    assert.equal(result.requests.length, 1);
  }
  const http = { ...input, solanaRpcUrl: "http://rpc.example/api" },
    rejected = await invoke(
      [...root, "create", "--data", JSON.stringify(http)],
      {},
      {
        reply: Response.json(
          { error: { code: "BAD_REQUEST", message: "Plain HTTP is development-only" }, meta },
          { status: 400 }
        ),
      }
    );
  assert.equal(rejected.code, 1);
  assert.equal(rejected.requests.length, 1);
  assert.deepEqual(body(rejected.requests[0]), http);
});
test("safe metadata preserves null fields, check failures, ports and IPv6 origins", async () => {
  const safe = {
    ...connection,
    status: "failed",
    isDefault: false,
    endpoints: {
      rpc: "https://[2001:db8::1]:8443",
      indexer: null,
      prover: "http://prover.example:8080",
      ringRpc: null,
    },
    lastCheckStatus: "failed",
    lastCheckAt: meta.timestamp,
    lastCheckFailureCode: "rpc_unavailable",
  };
  const result = await invoke([...root, "list"], { connections: [safe] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data: { connections: [safe] }, meta });
});
test("setup response contracts reject keyed endpoints and unexpected credential fields before stdout", async () => {
  const unsafe: JsonObject[] = [
    { ...connection, solanaRpcUrl: input.solanaRpcUrl },
    { ...connection, endpoints: { ...connection.endpoints, rpc: input.solanaRpcUrl } },
    {
      ...connection,
      endpoints: { ...connection.endpoints, rpc: "https://user:password@rpc.example" },
    },
    { ...connection, endpoints: { ...connection.endpoints, rpc: "https://rpc.example/path" } },
    {
      ...connection,
      endpoints: { ...connection.endpoints, rpc: "https://rpc.example#credential" },
    },
    { ...connection, endpoints: { ...connection.endpoints, apiKey: keys.rpc } },
  ];
  for (const data of unsafe) {
    const result = await invoke([...root, "create", "--data", JSON.stringify(input)], data);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
    assert(!result.stderr.includes(keys.rpc));
  }
  const list = await invoke([...root, "list"], { connections: [connection], credentials: input });
  assert.equal(list.code, 1);
  assert.equal(list.stdout, "");
  const check = await invoke([...root, "test", connection.id], {
    health: { rpc: "green", prover: "green", photon: "green" },
    ringRpc: null,
    solanaRpcUrl: input.solanaRpcUrl,
  });
  assert.equal(check.code, 1);
  assert.equal(check.stdout, "");
});
test("creation errors redact all submitted endpoint URLs and query credentials recursively", async () => {
  const urls = [input.solanaRpcUrl, input.indexerUrl, input.proverUrl, input.ringRpcUrl];
  const values = [...urls, ...Object.values(keys)],
    message = values.join(" | ");
  const details = {
    [input.solanaRpcUrl]: values.flatMap((value) => [
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ]),
    nested: { value: keys.prover },
    reason: "probe_failed",
  };
  const reply = Response.json(
    { error: { code: "CONFLICT", message, details }, meta: { requestId: input.indexerUrl } },
    { status: 409 }
  );
  const result = await invoke([...root, "create", "--data", JSON.stringify(input)], {}, { reply });
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 1);
  const error = JSON.parse(result.stderr).error;
  for (const value of values) {
    assert(!result.stderr.includes(encodeURIComponent(value)));
    assert(!JSON.stringify(error).includes(value));
  }
  assert(error.message.includes("[REDACTED]"));
  assert.equal(error.details.reason, "probe_failed");
  assert.equal(error.requestId, "[REDACTED]");
});
test("failed probes and blocked deactivations never trigger a default switch, retry or void", async () => {
  const health = {
    health: { rpc: "red", prover: "amber", photon: "green", detail: { rpc: "rpc_unavailable" } },
    ringRpc: null,
  };
  const tested = await invoke([...root, "test", "connection/example?#"], health);
  assert.equal(tested.code, 0, tested.stderr);
  assert.deepEqual(JSON.parse(tested.stdout).data, health);
  assert.equal(tested.requests.length, 1);
  assert.equal(tested.requests[0].init.body, undefined);
  for (const reason of ["is_default", "unsettled_operations"]) {
    const reply = Response.json(
        { error: { code: "CONFLICT", message: "Deactivation refused", details: { reason } }, meta },
        { status: 409 }
      ),
      result = await invoke([...root, "deactivate", connection.id], {}, { reply });
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stderr).error.details.reason, reason);
    assert.equal(result.requests[0].init.body, undefined);
  }
});
test("default selection and deactivation preserve each returned lifecycle without chaining", async () => {
  for (const [verb, data] of [
    ["make-default", connection],
    ["deactivate", { ...connection, isDefault: false, status: "deactivated" }],
  ] as const) {
    const result = await invoke([...root, verb, "connection/example?#"], data);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(
      new URL(result.requests[0].url).pathname,
      `/internal/dashboard/helius-rings/connections/connection%2Fexample%3F%23/${verb}`
    );
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(new Headers(result.requests[0].init.headers).get("idempotency-key"), null);
    assert.deepEqual(JSON.parse(result.stdout).data, data);
  }
});
