import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  getSdpAuth: vi.fn(),
  logRouteResult: vi.fn(),
  releaseChannel: "experimental" as SdpReleaseChannel,
}));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
}));

vi.mock("@/lib/sdp-auth", () => ({
  getSdpAuth: mocks.getSdpAuth,
}));

vi.mock("@/flags/release-channel", () => ({
  deploymentReleaseChannel: () => mocks.releaseChannel,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    traceId: "trace_test",
    serverTiming: () => "total;dur=1",
    childContext: () => ({ traceId: "trace_test", source: "route.playground.execute.api" }),
  }),
  logRouteResult: mocks.logRouteResult,
}));

import { POST } from "./route";

const PROJECT_ID = "prj_selected";

function executeRequest(
  envelope: Record<string, unknown>,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://dashboard.example.com/api/playground/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-project-id": PROJECT_ID, ...headers },
    body: JSON.stringify(envelope),
  });
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

describe("POST /api/playground/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.releaseChannel = "experimental";
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
  });

  it("rejects an unauthenticated caller before creating an API client", async () => {
    mocks.getSdpAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await POST(executeRequest({ method: "GET", path: "/v1/wallets/configs" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires the calling tab's project, like every other dashboard route", async () => {
    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        body: JSON.stringify({ method: "GET", path: "/v1/wallets/configs" }),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("runs a catalog operation on the dashboard session client, query included", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk({ data: { wallets: [] } }));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      executeRequest({ method: "GET", path: "/v1/wallets/wal_1?includeBalance=true" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 200 });
    expect(mocks.createSdpApiClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/v1/wallets/wal_1?includeBalance=true",
      expect.objectContaining({ method: "GET", body: undefined })
    );
  });

  it.each([
    ["an internal mount", "POST", "/internal/dashboard/custody/wallets"],
    ["an admin mount", "POST", "/admin/allowlist"],
    ["a non-versioned path", "GET", "/health"],
    ["a dashboard-only family", "GET", "/v1/api-keys"],
    ["an undocumented public route", "POST", "/v1/payments/requests"],
    ["a documented path under the wrong method", "DELETE", "/v1/payments/transfers"],
    ["an extra segment", "GET", "/v1/payments/transfers/trf_1/extra"],
    ["an empty path parameter", "GET", "/v1/payments/transfers/"],
    ["an absolute URL", "GET", "https://evil.example.com/v1/wallets/configs"],
    ["a protocol-relative URL", "GET", "//evil.example.com/v1/wallets/configs"],
    ["literal parent segments", "POST", "/v1/payments/transfers/../../../admin/allowlist"],
    ["percent-encoded parent segments", "GET", "/v1/%2e%2e/admin/allowlist"],
    ["backslash parent segments", "GET", "/v1/wallets/..\\..\\admin/allowlist"],
  ])("refuses %s that is not in the playground catalog", async (_label, method, path) => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest({ method, path }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not a playground operation" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a catalog operation the deployment's release channel does not run", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const issue = { method: "POST", path: "/v1/issuance/tokens", body: { name: "T" } };

    mocks.releaseChannel = "stable";
    expect((await POST(executeRequest(issue))).status).toBe(404);
    expect(request).not.toHaveBeenCalled();

    mocks.releaseChannel = "experimental";
    expect((await POST(executeRequest(issue))).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("matches a literal segment before a path parameter", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest({ method: "GET", path: "/v1/wallets/configs" }));

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
    const transfer = {
      method: "POST",
      path: "/v1/payments/transfers",
      body: { amount: "1.00" },
    };
    const idempotencyKey = "8a0f7c55-3a02-4f5e-9d61-0f1f6d0a2b7e";

    await POST(executeRequest({ ...transfer, idempotencyKey }));
    await POST(executeRequest({ ...transfer, idempotencyKey }));

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

    await POST(
      executeRequest({
        method: "GET",
        path: "/v1/payments/transfers/trf_1",
        idempotencyKey: "key_1",
      })
    );

    expect(forwardedHeaders(request).has("Idempotency-Key")).toBe(false);
  });

  it("forwards nothing else from the client, an Authorization bearer least of all", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk());
    mocks.createSdpApiClient.mockResolvedValue({ request });

    await POST(
      executeRequest(
        {
          method: "POST",
          path: "/v1/payments/transfers",
          body: { amount: "1.00" },
          idempotencyKey: "key_1",
        },
        {
          Authorization: "Bearer sk_live_pasted_secret",
          "X-API-Key": "sk_live_pasted_secret",
          "X-Forwarded-For": "203.0.113.7",
          Cookie: "session=abc",
          "Idempotency-Key": "key_from_a_header",
        }
      )
    );

    const headers = [...forwardedHeaders(request).keys()];
    expect(headers).toEqual(["idempotency-key"]);
    expect(forwardedHeaders(request).get("Idempotency-Key")).toBe("key_1");
  });

  it("refuses an envelope that still carries a pasted API key", async () => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      executeRequest({
        method: "GET",
        path: "/v1/wallets/configs",
        apiKey: "sk_test_pasted_secret",
      })
    );

    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses an oversized Idempotency-Key", async () => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      executeRequest({
        method: "POST",
        path: "/v1/payments/transfers",
        body: {},
        idempotencyKey: "k".repeat(256),
      })
    );

    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("passes only allowlisted response headers through", async () => {
    const request = upstreamRequest().mockResolvedValue(
      upstreamOk(
        { data: [] },
        {
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "key_1",
            "X-SDP-Trace-ID": "trace_upstream",
            "Set-Cookie": "session=abc",
            "X-Internal-Route": "pod-7",
          },
        }
      )
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest({ method: "GET", path: "/v1/wallets/configs" }));
    const envelope = z
      .object({ headers: z.record(z.string(), z.string()) })
      .parse(await response.json());

    expect(envelope.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": "key_1",
      "x-sdp-trace-id": "trace_upstream",
    });
  });

  it("fails closed with a generic 500 when the upstream call throws", async () => {
    const request = upstreamRequest().mockRejectedValue(new Error("socket hang up"));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest({ method: "GET", path: "/v1/wallets/configs" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Playground execution failed" });
  });

  it("rejects an oversized request envelope before parsing it", async () => {
    const request = upstreamRequest();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      executeRequest({
        method: "POST",
        path: "/v1/payments/transfers",
        body: { memo: "x".repeat(256 * 1024) },
      })
    );

    expect(response.status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with a 400 instead of a 500", async () => {
    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "x-project-id": PROJECT_ID },
        body: "not-json{",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("forwards documented request bodies for DELETE operations", async () => {
    const request = upstreamRequest().mockResolvedValue(upstreamOk({ deleted: true }));
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const body = { provider: "anchorage", walletId: "anchorage_wallet_123" };

    const response = await POST(executeRequest({ method: "DELETE", path: "/v1/wallets", body }));

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "/v1/wallets",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify(body) })
    );
  });
});
