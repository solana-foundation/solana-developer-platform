import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  getSdpAuth: vi.fn(),
  logRouteResult: vi.fn(),
  releaseChannel: "experimental" as SdpReleaseChannel,
}));

vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

vi.mock("@/lib/sdp-auth", () => ({
  getSdpAuth: mocks.getSdpAuth,
}));

vi.mock("@/flags/release-channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/flags/release-channel")>()),
  deploymentReleaseChannel: () => mocks.releaseChannel,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    traceId: "trace_test",
    serverTiming: () => "total;dur=1",
    childContext: () => ({ traceId: "trace_test", source: "route.playground.proxy.api" }),
  }),
  logRouteResult: mocks.logRouteResult,
}));

import { DELETE, GET, PATCH, POST, PUT } from "./route";

const PROJECT_ID = "prj_selected";
const ORIGIN = "https://dashboard.example.com";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A playground call as the shell makes it: the API path under `/api/playground`. */
function playgroundRequest(
  method: Method,
  path: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}
): Request {
  return new Request(`${ORIGIN}/api/playground${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-project-id": PROJECT_ID, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The route's handler for a method, as Next would dispatch it. */
function handlerFor(method: Method): (request: Request) => Promise<Response> {
  switch (method) {
    case "GET":
      return GET;
    case "POST":
      return POST;
    case "PUT":
      return PUT;
    case "PATCH":
      return PATCH;
    case "DELETE":
      return DELETE;
    default: {
      const unreachable: never = method;
      throw new Error(`Unsupported method: ${String(unreachable)}`);
    }
  }
}

function upstreamOk(body: unknown = { data: {} }, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type UpstreamRequest = Mock<(path: string, init: RequestInit) => Promise<Response>>;

/** The session client's `request`, typed so its calls read without assertions. */
function upstreamRequest(): UpstreamRequest {
  return vi.fn<(path: string, init: RequestInit) => Promise<Response>>();
}

/** The headers the route handed the session client for its one upstream call. */
function forwardedHeaders(request: UpstreamRequest): Headers {
  const call = request.mock.calls[0];
  if (call === undefined) throw new Error("the route made no upstream call");
  return new Headers(call[1].headers);
}

describe("/api/playground/v1/[...path]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.releaseChannel = "experimental";
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
  });

  it("rejects an unauthenticated caller before creating an API client", async () => {
    mocks.getSdpAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(playgroundRequest("GET", "/v1/wallets/configs"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Authentication required" },
    });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires the calling tab's project, like every other dashboard route", async () => {
    const response = await GET(new Request(`${ORIGIN}/api/playground/v1/wallets/configs`));

    expect(response.status).toBe(400);
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("runs a catalog operation on the dashboard session client, query included", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk({ data: { wallets: [] } }));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(playgroundRequest("GET", "/v1/wallets/wal_1?includeBalance=true"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { wallets: [] } });
    expect(mocks.createSdpApiClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/v1/wallets/wal_1?includeBalance=true",
      expect.objectContaining({ method: "GET", body: undefined })
    );
  });

  it("returns the upstream status and body as they are, an error included", async () => {
    const refusal = { error: { code: "FORBIDDEN", message: "Missing permission" } };
    const request = upstreamRequest().mockResolvedValue(
      upstreamOk(refusal, { status: 403, statusText: "Forbidden" })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      playgroundRequest("POST", "/v1/payments/transfers", { body: { amount: "1.00" } })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(refusal);
    expect(mocks.logRouteResult).toHaveBeenLastCalledWith(expect.anything(), 403, {
      method: "POST",
      operation: "/v1/payments/transfers",
      ok: false,
    });
  });

  // `new URL` resolves dot segments and backslashes the way Next hands the
  // request to the route, so these arrive outside `/api/playground/v1/`.
  it.each<[string, Method, string]>([
    ["an internal mount", "POST", "/internal/dashboard/custody/wallets"],
    ["an admin mount", "POST", "/admin/allowlist"],
    ["a non-versioned path", "GET", "/health"],
    ["a dashboard-only family", "GET", "/v1/api-keys"],
    ["an undocumented public route", "POST", "/v1/payments/requests"],
    ["a documented path under the wrong method", "DELETE", "/v1/payments/transfers"],
    ["an extra segment", "GET", "/v1/payments/transfers/trf_1/extra"],
    ["an empty path parameter", "GET", "/v1/payments/transfers/"],
    ["literal parent segments", "POST", "/v1/payments/transfers/../../../admin/allowlist"],
    ["percent-encoded parent segments", "GET", "/v1/%2e%2e/admin/allowlist"],
    ["backslash parent segments", "GET", "/v1/wallets/..\\..\\admin/allowlist"],
    ["a parent segment out of the proxy", "GET", "/v1/../v1/wallets/configs/../../../health"],
  ])("refuses %s that is not in the playground catalog", async (_label, method, path) => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await handlerFor(method)(playgroundRequest(method, path));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Not a playground operation" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a catalog operation the deployment's release channel does not run", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const issue = () => playgroundRequest("POST", "/v1/issuance/tokens", { body: { name: "T" } });

    mocks.releaseChannel = "stable";
    expect((await POST(issue())).status).toBe(404);
    expect(request).not.toHaveBeenCalled();

    mocks.releaseChannel = "experimental";
    expect((await POST(issue())).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Greptile (#2433): the API's router sends this to the dashboard-only accounts
  // list, not to the published counterparty read whose template it fits.
  it("refuses a path an unpublished literal API route would take, and runs the template's own", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    expect((await GET(playgroundRequest("GET", "/v1/counterparties/accounts"))).status).toBe(404);
    expect(request).not.toHaveBeenCalled();

    expect((await GET(playgroundRequest("GET", "/v1/counterparties/cpty_1"))).status).toBe(200);
    expect(request).toHaveBeenCalledWith("/v1/counterparties/cpty_1", expect.anything());
  });

  it("matches a literal segment before a path parameter", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(playgroundRequest("GET", "/v1/wallets/configs"));

    expect(response.status).toBe(200);
    expect(mocks.logRouteResult).toHaveBeenLastCalledWith(expect.anything(), 200, {
      method: "GET",
      operation: "/v1/wallets/configs",
      ok: true,
    });
  });

  it("forwards the shell's idempotency key on a POST, and the same key on its retry", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk({ data: { id: "trf_1" } }));
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const idempotencyKey = "8a0f7c55-3a02-4f5e-9d61-0f1f6d0a2b7e";
    const transfer = () =>
      playgroundRequest("POST", "/v1/payments/transfers", {
        body: { amount: "1.00" },
        headers: { "Idempotency-Key": idempotencyKey },
      });

    await POST(transfer());
    await POST(transfer());

    expect(request).toHaveBeenCalledTimes(2);
    for (const [path, init] of request.mock.calls) {
      expect(path).toBe("/v1/payments/transfers");
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(idempotencyKey);
      expect(init.body).toBe(JSON.stringify({ amount: "1.00" }));
    }
  });

  it("does not forward an Idempotency-Key on a GET", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    await GET(
      playgroundRequest("GET", "/v1/payments/transfers/trf_1", {
        headers: { "Idempotency-Key": "key_1" },
      })
    );

    expect(forwardedHeaders(request).has("Idempotency-Key")).toBe(false);
  });

  it("forwards no client header but the Idempotency-Key", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    await POST(
      playgroundRequest("POST", "/v1/payments/transfers", {
        body: { amount: "1.00" },
        headers: {
          "Idempotency-Key": "key_1",
          "X-Forwarded-For": "203.0.113.7",
          Cookie: "session=abc",
          "X-Project-ID": "prj_other",
          "X-SDP-Trace-ID": "trace_client",
        },
      })
    );

    expect([...forwardedHeaders(request).keys()]).toEqual(["idempotency-key"]);
    expect(forwardedHeaders(request).get("Idempotency-Key")).toBe("key_1");
  });

  it.each([
    ["an Authorization bearer", { Authorization: "Bearer sk_live_pasted_secret" }],
    ["an X-API-Key", { "X-API-Key": "sk_live_pasted_secret" }],
  ])(
    "refuses a request that carries %s instead of running it as the session",
    async (_label, headers) => {
      const request = upstreamRequest();
      mocks.createSdpApiClient.mockResolvedValue({ request });

      const response = await GET(playgroundRequest("GET", "/v1/wallets/configs", { headers }));

      expect(response.status).toBe(400);
      expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    }
  );

  it("refuses an oversized Idempotency-Key", async () => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      playgroundRequest("POST", "/v1/payments/transfers", {
        body: {},
        headers: { "Idempotency-Key": "k".repeat(256) },
      })
    );

    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("passes only allowlisted response headers through, under its own cache and trace headers", async () => {
    const request = upstreamRequest().mockResolvedValue(
      upstreamOk(
        { data: [] },
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "999",
            "Cache-Control": "public, max-age=60",
            "Idempotency-Key": "key_1",
            "Idempotent-Replayed": "true",
            "X-SDP-Trace-ID": "trace_upstream",
            "Set-Cookie": "session=abc",
            "X-Internal-Route": "pod-7",
          },
        }
      )
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(playgroundRequest("GET", "/v1/wallets/configs"));

    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "idempotency-key": "key_1",
      "idempotent-replayed": "true",
      "server-timing": "total;dur=1",
      "x-sdp-trace-id": "trace_test",
    });
  });

  it("fails closed with a generic 500 when the upstream call throws", async () => {
    const request = upstreamRequest().mockRejectedValue(new Error("socket hang up"));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(playgroundRequest("GET", "/v1/wallets/configs"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Playground execution failed" },
    });
  });

  it("rejects an oversized request body before calling the API", async () => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      playgroundRequest("POST", "/v1/payments/transfers", {
        body: { memo: "x".repeat(256 * 1024) },
      })
    );

    expect(response.status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards documented request bodies for DELETE operations", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk({ deleted: true }));
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const body = { provider: "anchorage", walletId: "anchorage_wallet_123" };

    const response = await DELETE(playgroundRequest("DELETE", "/v1/wallets", { body }));

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "/v1/wallets",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify(body) })
    );
  });
});
