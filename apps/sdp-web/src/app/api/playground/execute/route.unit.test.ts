import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  getSdpAuth: vi.fn(),
  logRouteResult: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: mocks.createSdpApiClient }));

vi.mock("@/lib/sdp-auth", () => ({ getSdpAuth: mocks.getSdpAuth }));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    traceId: "trace_test",
    serverTiming: () => "total;dur=1",
    childContext: () => ({ traceId: "trace_test", source: "route.playground.execute.api" }),
  }),
  logRouteResult: mocks.logRouteResult,
}));

import { POST } from "./route";

/** The headers part of the playground's envelope. */
const envelopeHeadersSchema = z.object({ headers: z.record(z.string(), z.string()) });

const OWNED_API_KEY = "sk_test_owned_secret";

function executeRequest(apiKey: string | null = OWNED_API_KEY): Request {
  return new Request("https://dashboard.example.com/api/playground/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "POST",
      path: "/v1/payments/transfers",
      body: { amount: "1.00" },
      apiKey,
    }),
  });
}

describe("POST /api/playground/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
  });

  it("rejects an unauthenticated caller before creating an API client", async () => {
    mocks.getSdpAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await POST(executeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required" });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("rejects a foreign key without forwarding the requested operation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403, statusText: "Forbidden" }));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest("sk_live_foreign_secret"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "API key is not available for the selected project",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/internal/playground/api-key/verify", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk_live_foreign_secret" }),
    });
  });

  it("forwards an exact owned key only after verification succeeds", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { transferId: "trf_1" } }), {
          status: 201,
          statusText: "Created",
          headers: { "Content-Type": "application/json" },
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 201,
      statusText: "Created",
    });
    expect(request).toHaveBeenNthCalledWith(1, "/internal/playground/api-key/verify", {
      method: "POST",
      body: JSON.stringify({ apiKey: OWNED_API_KEY }),
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/v1/payments/transfers",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: `Bearer ${OWNED_API_KEY}` },
      })
    );
  });

  it("fails closed when ownership verification cannot be resolved", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error(`request failed for Bearer ${OWNED_API_KEY}`));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest());
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ error: "Playground execution failed" });
    expect(responseText).not.toContain(OWNED_API_KEY);
    expect(mocks.logRouteResult).toHaveBeenLastCalledWith(expect.anything(), 500, {
      error: "Playground execution failed",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("redacts a rejected upstream response that echoes the submitted secret", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: `Rejected ${OWNED_API_KEY}` }), {
          status: 400,
          statusText: `Rejected ${OWNED_API_KEY}`,
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest());
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      ok: false,
      status: 400,
      statusText: "Rejected [REDACTED]",
      body: { error: "Rejected [REDACTED]" },
      // A string body gets the fetch default content type.
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
    expect(responseText).not.toContain(OWNED_API_KEY);
  });

  it("passes only allowlisted response headers through, with the secret redacted", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-SDP-Trace-ID": `trace ${OWNED_API_KEY}`,
            "Set-Cookie": "session=abc",
            "X-Internal-Route": "pod-7",
          },
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest());
    const envelope = envelopeHeadersSchema.parse(await response.json());

    expect(envelope.headers).toEqual({
      "content-type": "application/json",
      "x-sdp-trace-id": "trace [REDACTED]",
    });
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["whitespace", "   "],
  ])(
    "rejects requests with a %s apiKey instead of falling back to the session",
    async (_label, apiKey) => {
      const request = vi.fn();
      mocks.createSdpApiClient.mockResolvedValue({ request });

      const response = await POST(executeRequest(apiKey));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "API key is required" });
      // No downstream call happened — no session-authed request escaped.
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["an internal mount", "/internal/playground/api-key/verify"],
    ["an admin mount", "/admin/allowlist"],
    ["a non-versioned path", "/health"],
  ])("refuses to replay against %s", async (_label, path) => {
    const request = vi.fn();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "POST", path, apiKey: OWNED_API_KEY }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Path must start with '/v1/'" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["literal parent segments", "/v1/../internal/playground/api-key/verify"],
    ["nested parent segments", "/v1/payments/../../admin/allowlist"],
    ["percent-encoded parent segments", "/v1/%2e%2e/admin/allowlist"],
    ["backslash parent segments", "/v1/..\\internal/playground/api-key/verify"],
  ])("refuses to replay a path containing %s", async (_label, path) => {
    const request = vi.fn();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "POST", path, apiKey: OWNED_API_KEY }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Path must start with '/v1/'" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized request envelope before parsing it", async () => {
    const request = vi.fn();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "POST",
          path: "/v1/payments/transfers",
          body: { memo: "x".repeat(256 * 1024) },
          apiKey: OWNED_API_KEY,
        }),
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with a 400 instead of a 500", async () => {
    const request = vi.fn();
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(
      new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards documented request bodies for DELETE operations", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });
    const body = { provider: "anchorage", walletId: "anchorage_wallet_123" };
    const deleteRequest = new Request("https://dashboard.example.com/api/playground/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "DELETE",
        path: "/v1/wallets",
        body,
        apiKey: OWNED_API_KEY,
      }),
    });

    const response = await POST(deleteRequest);

    expect(response.status).toBe(200);
    expect(request).toHaveBeenNthCalledWith(2, "/v1/wallets", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OWNED_API_KEY}` },
      body: JSON.stringify(body),
    });
  });

  describe("Idempotency-Key", () => {
    const KEY = "0b6f3c1e-8d2a-4a8e-9f5b-3c2d1e0f4a7b";

    function envelope(fields: Record<string, unknown>): Request {
      return new Request("https://dashboard.example.com/api/playground/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/v1/payments/transfers", apiKey: OWNED_API_KEY, ...fields }),
      });
    }

    function verifiedThen(upstream: Response) {
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(upstream);
      mocks.createSdpApiClient.mockResolvedValue({ request });
      return request;
    }

    it("forwards the key on a POST and shows the replay headers", async () => {
      const request = verifiedThen(
        new Response(JSON.stringify({ data: {} }), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": KEY,
            "Idempotent-Replayed": "true",
          },
        })
      );

      const response = await POST(
        envelope({ method: "POST", body: { amount: "1.00" }, idempotencyKey: KEY })
      );

      expect(response.status).toBe(200);
      expect(request).toHaveBeenNthCalledWith(2, "/v1/payments/transfers", {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNED_API_KEY}`, "Idempotency-Key": KEY },
        body: JSON.stringify({ amount: "1.00" }),
      });
      const { headers } = envelopeHeadersSchema.parse(await response.json());
      expect(headers["idempotency-key"]).toBe(KEY);
      expect(headers["idempotent-replayed"]).toBe("true");
    });

    it("does not forward the key on a GET", async () => {
      const request = verifiedThen(new Response("{}", { status: 200 }));

      const response = await POST(envelope({ method: "GET", idempotencyKey: KEY }));

      expect(response.status).toBe(200);
      expect(request).toHaveBeenNthCalledWith(2, "/v1/payments/transfers", {
        method: "GET",
        headers: { Authorization: `Bearer ${OWNED_API_KEY}` },
        body: undefined,
      });
    });

    it.each([
      ["empty", ""],
      ["too long", "k".repeat(256)],
      ["non-ASCII", "kéy"],
      ["a control character", "key\u0007"],
      ["not a string", 42],
    ])("rejects a %s key with 400 before any upstream call", async (_label, idempotencyKey) => {
      const request = vi.fn();
      mocks.createSdpApiClient.mockResolvedValue({ request });

      const response = await POST(envelope({ method: "POST", idempotencyKey }));

      expect(response.status).toBe(400);
      expect(request).not.toHaveBeenCalled();
    });
  });
});
