import assert from "node:assert/strict";
import test from "node:test";
import {
  NETWORK_HEALTH_STATES,
  NETWORK_METRIC_IDS,
  type NetworkSnapshot,
  networkSnapshotSchema,
} from "@sdp/types/network-metrics";
import { type Json, operationById } from "./contract";
import { runCli } from "./run";

const meta = { requestId: "req_network", timestamp: "2026-10-29T00:00:00.000Z" };
const snapshot: NetworkSnapshot = {
  asOf: "2026-10-27",
  health: { state: "operational", checkedAt: "2026-10-29T00:00:00.000Z" },
  metrics: {
    stablecoinSupply: [
      { date: "2026-10-26", value: 15894704166.8 },
      { date: "2026-10-27", value: 0 },
    ],
    stablecoinTransfers: [],
    stablecoinShare: [{ date: "2026-10-27", value: 12.3456 }],
    costPerTransaction: [{ date: "2026-10-27", value: 0.0000000087 }],
  },
};
const session = { SDP_TOKEN: "network-session", SDP_API_URL: "http://localhost:8787" };
const args = ["network", "snapshot", "get"];
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(cliArgs = args, options: { env?: NodeJS.ProcessEnv; reply?: Response } = {}) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(cliArgs, {
    env: options.env ?? session,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return options.reply ?? Response.json({ data: snapshot, meta });
    },
    readStdin: async () => {
      throw new Error("Snapshot must not read stdin");
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}

test("network help is offline and distinguishes session authentication from public access", async () => {
  for (const cliArgs of [
    ["network", "--help"],
    [...args, "--help"],
  ]) {
    const result = await invoke(cliArgs, { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("snapshot"));
    if (cliArgs.length === 3) {
      assert(result.stdout.includes("Clerk session"));
      assert(result.stdout.includes("API keys are refused"));
      assert(result.stdout.includes("No tenant action"));
      assert(!result.stdout.includes("Select a project with"));
    }
  }
  const operation = operationById("getDashboardNetworkSnapshot");
  assert.equal(operation.path, "/internal/dashboard/network");
  assert.equal(operation.method, "GET");
  assert.equal(operation.sessionOnly, true);
  assert.deepEqual(operation.authorization, { kind: "session" });
  assert.deepEqual(operation.parameters, []);
  assert.equal(operation.body, null);
});
test("network snapshots require a session and refuse API keys before making a request", async () => {
  for (const env of [{}, { SDP_API_KEY: "forbidden-key" }, { SDP_TOKEN: "" }]) {
    const result = await invoke(args, { env });
    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
    assert.equal(result.stdout, "");
  }
  const explicit = await invoke([...args, "--token", session.SDP_TOKEN], {
    env: { SDP_API_KEY: "ignored-environment-key" },
  });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(
    new Headers(explicit.requests[0].init.headers).get("authorization"),
    "Bearer network-session"
  );
});
test("snapshot sends one unscoped GET and preserves dates, zeros, small numbers and empty series", async () => {
  const result = await invoke();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0],
    headers = new Headers(request.init.headers);
  assert.equal(request.url, "http://localhost:8787/internal/dashboard/network");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  assert.equal(headers.get("authorization"), "Bearer network-session");
  for (const name of ["x-project-id", "x-organization-id", "idempotency-key", "content-type"])
    assert.equal(headers.get(name), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: snapshot, meta });
  assert.equal(result.stderr, "");
});
test("global tenant selectors do not change chain-wide network data or send tenant headers", async () => {
  const result = await invoke(
    [...args, "--project", "prj_ignored", "--organization", "org_ignored"],
    {
      env: {
        ...session,
        SDP_PROJECT_ID: "prj_environment",
        SDP_ORGANIZATION_ID: "org_environment",
      },
    }
  );
  assert.equal(result.code, 0, result.stderr);
  const headers = new Headers(result.requests[0].init.headers);
  assert.equal(headers.get("x-project-id"), null);
  assert.equal(headers.get("x-organization-id"), null);
  assert.equal(new URL(result.requests[0].url).search, "");
  assert.deepEqual(JSON.parse(result.stdout).data, snapshot);
});
test("unavailable health and every observed health state retain their independent timestamps", async () => {
  for (const state of [null, ...NETWORK_HEALTH_STATES]) {
    const data = {
      ...snapshot,
      asOf: "2020-01-01",
      health: state === null ? null : { state, checkedAt: "2020-01-02T00:00:00.000Z" },
      metrics: Object.fromEntries(NETWORK_METRIC_IDS.map((id) => [id, []])),
    };
    assert(networkSnapshotSchema.safeParse(data).success);
    const result = await invoke(args, { reply: Response.json({ data, meta }) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { data, meta });
    assert.equal(result.requests.length, 1);
  }
});
test("snapshot schemas reject missing metrics, unknown readings, malformed dates and mistyped values", async () => {
  const { stablecoinSupply: _supply, ...incomplete } = snapshot.metrics;
  const { health: _health, ...noHealth } = snapshot;
  const malformed: Json[] = [
    { ...snapshot, metrics: incomplete },
    { ...snapshot, metrics: { ...snapshot.metrics, tps: [] } },
    { ...snapshot, asOf: "2026-02-30" },
    { ...snapshot, health: { state: "green", checkedAt: meta.timestamp } },
    { ...snapshot, health: { state: "operational" } },
    { ...snapshot, health: { state: "operational", checkedAt: "today" } },
    {
      ...snapshot,
      metrics: { ...snapshot.metrics, stablecoinSupply: [{ date: "2026-10-27", value: "0" }] },
    },
    {
      ...snapshot,
      metrics: { ...snapshot.metrics, stablecoinSupply: [{ date: "2026-02-30", value: 1 }] },
    },
    { ...snapshot, metrics: { ...snapshot.metrics, stablecoinSupply: null } },
    noHealth,
  ];
  for (const data of malformed) {
    assert.equal(networkSnapshotSchema.safeParse(data).success, false);
    const result = await invoke(args, { reply: Response.json({ data, meta }) });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
test("unsupported network, filtering, body and replay options fail locally", async () => {
  for (const extra of [
    ["--network", "devnet"],
    ["--limit", "1"],
    ["--from", "2026-01-01"],
    ["--data", "{}"],
    ["--idempotency-key", "not-supported"],
    ["extra-resource-id"],
  ]) {
    const result = await invoke([...args, ...extra]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("provider failures preserve diagnostic details and redact the session without retry or fallback data", async () => {
  for (const code of ["PROVIDER_NOT_CONFIGURED", "PROVIDER_UNAVAILABLE"]) {
    const result = await invoke(args, {
      reply: Response.json(
        {
          error: {
            code,
            message: `Network source failed for ${session.SDP_TOKEN}`,
            details: { provider: "solana-data" },
          },
          meta,
        },
        { status: 503 }
      ),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.requests.length, 1);
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code,
      message: "Network source failed for [REDACTED]",
      details: { provider: "solana-data" },
      status: 503,
      requestId: meta.requestId,
    });
  }
});
