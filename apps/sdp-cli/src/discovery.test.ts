import assert from "node:assert/strict";
import test from "node:test";
import { EGRESS_READINESS_SERVES_TRAFFIC, EGRESS_READINESS_STATES } from "@sdp/types/health";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { type Json, operationById } from "./contract";
import { discoveryCommands } from "./discovery-commands";
import { runCli } from "./run";

const timestamp = "2026-10-29T00:00:00.000Z";
const health = {
  status: "ok",
  timestamp,
  version: "v1",
  environment: "production",
  releaseChannel: "stable",
};
const ready = {
  status: "ready",
  timestamp,
  revision: "sdp-revision",
  commit: "local",
  checks: { database: "ok", redis: "ok" },
};
const document = {
  openapi: "3.0.3",
  info: { title: "Deployment API", version: "0.1.0", description: "Stable only" },
  paths: { "/health": { get: { responses: { "200": { description: "OK" } } } } },
  "x-preserved": [0, false, null],
};
const html = '<!doctype html>\n<html><script>window.example = "é";</script></html>\n';
const llms = "# Solana Developer Platform\n\n- [OpenAPI](/openapi.json)\n";
const etag = 'W/"document-123"';
const cache = "public, max-age=3600";
const base = { SDP_API_URL: "http://localhost:8787" };
interface RecordedRequest {
  url: string;
  init: RequestInit;
}
function reply(args: string[]) {
  if (args[0] === "health") return Response.json(args[1] === "readiness" ? ready : health);
  switch (args[1]) {
    case "openapi":
      return Response.json(document, { headers: { etag, "cache-control": cache } });
    case "docs":
      return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
    case "ai-discovery":
      return new Response(llms, { headers: { "content-type": "text/plain; charset=UTF-8" } });
    case "root-redirect":
      return new Response(null, { status: 302, headers: { location: "/health" } });
    default:
      throw new Error("No fixture for this command");
  }
}
async function invoke(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; response?: Response } = {}
) {
  let stdout = "",
    stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? base,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return options.response ?? reply(args);
    },
    readStdin: async () => {
      throw new Error("Discovery must not read stdin");
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

test("six health/discovery operations have public contracts and offline help", async () => {
  assert.equal(discoveryCommands.length, 6);
  for (const command of discoveryCommands) {
    const operation = operationById(command.operationId);
    assert.deepEqual(operation.authorization, { kind: "public" });
    assert.equal(operation.sessionOnly, false);
    assert.equal(operation.body, null);
    const result = await invoke([...command.words, "--help"], { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stdout.includes("Public endpoint"));
    assert(result.stdout.includes("--include-headers"));
  }
  for (const args of [
    ["health", "--help"],
    ["api", "--help"],
  ])
    assert.equal((await invoke(args, { env: {} })).code, 0);
});
test("all six commands omit account credentials, tenant selectors, request bodies and query strings", async () => {
  for (const command of discoveryCommands) {
    const result = await invoke(
      [
        ...command.words,
        "--api-key",
        "ignored",
        "--token",
        "also ignored",
        "--project",
        "",
        "--organization",
        "",
      ],
      {
        env: {
          ...base,
          SDP_API_KEY: "invalid key",
          SDP_TOKEN: "invalid token",
          SDP_PROJECT_ID: "ignored",
          SDP_ORGANIZATION_ID: "ignored",
        },
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    const request = result.requests[0],
      headers = new Headers(request.init.headers);
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.body, undefined);
    assert.equal(new URL(request.url).pathname, operationById(command.operationId).path);
    assert.equal(new URL(request.url).search, "");
    for (const name of [
      "authorization",
      "x-project-id",
      "x-organization-id",
      "content-type",
      "idempotency-key",
    ])
      assert.equal(headers.get(name), null);
  }
});
test("health returns native build metadata and every server release channel without synthesizing defaults", async () => {
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    const data = { ...health, releaseChannel };
    const result = await invoke(["health", "check"], { response: Response.json(data) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), data);
    assert.equal(result.requests[0].init.redirect, "error");
  }
});
test("readiness preserves omitted egress and every shared egress state with the right exit status", async () => {
  const omitted = await invoke(["health", "readiness"]);
  assert.equal(omitted.code, 0, omitted.stderr);
  assert.deepEqual(JSON.parse(omitted.stdout), ready);
  assert(!Object.hasOwn(JSON.parse(omitted.stdout).checks, "egress"));
  for (const egress of EGRESS_READINESS_STATES) {
    const serves = EGRESS_READINESS_SERVES_TRAFFIC[egress];
    const report = {
      ...ready,
      status: serves ? "ready" : "not_ready",
      checks: { ...ready.checks, egress },
    };
    const result = await invoke(["health", "readiness"], {
      response: Response.json(report, { status: serves ? 200 : 503 }),
    });
    assert.equal(result.code, serves ? 0 : 1, result.stderr);
    assert.equal(result.requests.length, 1);
    if (serves) assert.deepEqual(JSON.parse(result.stdout), report);
    else {
      assert.equal(result.stdout, "");
      assert.deepEqual(JSON.parse(result.stderr).error.details, report);
    }
  }
});
test("a readiness 503 retains the complete diagnostic report in structured error details", async () => {
  const report = { ...ready, status: "not_ready", checks: { database: "error", redis: "error" } };
  const result = await invoke(["health", "readiness"], {
    response: Response.json(report, { status: 503, headers: { "x-request-id": "req_not_ready" } }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "HTTP_ERROR",
    message: "API request failed (HTTP 503).",
    status: 503,
    requestId: "req_not_ready",
    details: report,
  });
});
test("malformed health reports and mismatched readiness statuses are rejected before stdout", async () => {
  const cases: { args: string[]; data: Json; status: number }[] = [
    { args: ["health", "check"], data: { status: "ok" }, status: 200 },
    { args: ["health", "check"], data: { ...health, releaseChannel: "unknown" }, status: 200 },
    { args: ["health", "readiness"], data: { ...ready, status: "not_ready" }, status: 200 },
    { args: ["health", "readiness"], data: ready, status: 503 },
    { args: ["health", "readiness"], data: { ...ready, checks: { database: "ok" } }, status: 503 },
    { args: ["health", "readiness"], data: { ...ready, timestamp: "today" }, status: 200 },
  ];
  for (const item of cases) {
    const result = await invoke(item.args, {
      response: Response.json(item.data, { status: item.status }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
});
test("OpenAPI is fetched from the deployment and returned without merging the CLI's internal operations", async () => {
  const result = await invoke(["api", "openapi", "get"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), document);
  assert(!result.stdout.includes("/v1/earn"));
  assert.equal(result.requests.length, 1);
  assert.equal(new Headers(result.requests[0].init.headers).get("accept"), "application/json");
});
test("response-header output exposes the server ETag and wraps the exact document", async () => {
  const result = await invoke(["api", "openapi", "get", "--include-headers", "--compact"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 200);
  assert.equal(output.headers.etag, etag);
  assert.equal(output.headers["cache-control"], cache);
  assert.deepEqual(output.body, document);
  assert.equal(result.stdout.split("\n").length, 2);
});
test("If-None-Match remains a header and 304 reports metadata without inventing cached JSON", async () => {
  for (const validator of [etag, '"strong", W/"weak"', "*"]) {
    const result = await invoke(["api", "openapi", "get", "--if-none-match", validator], {
      response: new Response(null, { status: 304, headers: { etag, "cache-control": cache } }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(new Headers(result.requests[0].init.headers).get("if-none-match"), validator);
    assert.equal(new URL(result.requests[0].url).search, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 304,
      notModified: true,
      etag,
      cacheControl: cache,
    });
  }
});
test("HTML and AI text remain JSON strings and never execute or fetch their linked resources", async () => {
  for (const [command, text, type] of [
    ["docs", html, "text/html"],
    ["ai-discovery", llms, "text/plain"],
  ]) {
    const result = await invoke(["api", command, "get"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.stdout), text);
    assert.equal(
      new Headers(result.requests[0].init.headers).get("accept"),
      `${type}, application/json`
    );
    const wrapped = await invoke(["api", command, "get", "--include-headers"]);
    assert.equal(JSON.parse(wrapped.stdout).body, text);
    assert.equal(JSON.parse(wrapped.stdout).status, 200);
  }
});
test("text responses require the documented media type and nonempty body", async () => {
  for (const response of [
    new Response(html, { headers: { "content-type": "text/html" } }),
    new Response("", { headers: { "content-type": "text/plain" } }),
  ]) {
    const result = await invoke(["api", "ai-discovery", "get"], { response });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_RESPONSE");
  }
  const malformed = await invoke(["api", "openapi", "get"], {
    response: Response.json({ data: [] }),
  });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stdout, "");
});
test("the documented root redirect is reported without following it and unexpected locations are refused", async () => {
  const result = await invoke(["api", "root-redirect", "get"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].init.redirect, "manual");
  assert.deepEqual(JSON.parse(result.stdout), { status: 302, location: "/health" });
  const redirects: Record<string, string>[] = [{}, { location: "https://other.example/health" }];
  for (const headers of redirects) {
    const invalid = await invoke(["api", "root-redirect", "get"], {
      response: new Response(null, { status: 302, headers }),
    });
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, "");
    assert.equal(invalid.requests.length, 1);
  }
});
test("unsupported selectors, body/retry flags, malformed validators and unrelated header-output flags fail locally", async () => {
  for (const args of [
    ["health", "check", "--data", "{}"],
    ["health", "readiness", "--idempotency-key", "key"],
    ["api", "openapi", "get", "--release-channel", "experimental"],
    ["api", "ai-discovery", "get", "--if-none-match", "*"],
    ["api", "root-redirect", "get", "extra"],
    ["api", "docs", "get", "--output", "page.html"],
    ["api", "openapi", "get", "--if-none-match", ""],
    ["api", "openapi", "get", "--if-none-match", "bad\r\nheader"],
    ["projects", "list", "--include-headers"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
  }
});
test("discovery standard API errors remain structured and never trigger retries", async () => {
  const result = await invoke(["api", "openapi", "get"], {
    response: Response.json(
      {
        error: { code: "RATE_LIMITED", message: "Too many requests", details: { retryAfter: 60 } },
        meta: { requestId: "req_limit" },
      },
      { status: 429 }
    ),
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.requests.length, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "RATE_LIMITED");
  assert.deepEqual(JSON.parse(result.stderr).error.details, { retryAfter: 60 });
});
