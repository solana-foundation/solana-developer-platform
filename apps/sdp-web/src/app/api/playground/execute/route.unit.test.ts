import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  getSdpAuth: vi.fn(),
  logRouteResult: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
  getSdpAuth: mocks.getSdpAuth,
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
    const request = vi.fn().mockRejectedValueOnce(new Error("metadata service unavailable"));
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Playground execution failed" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves session-authenticated execution when no API key is supplied", async () => {
    const request = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await POST(executeRequest(null));

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/v1/payments/transfers",
      expect.objectContaining({ headers: {} })
    );
  });
});
