import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

import { createRequestScopedSdpApiClients, proxyToSdpApi, SdpApiResponseError } from "./sdp-api";

describe("createRequestScopedSdpApiClients", () => {
  const originalApiBaseUrl = process.env.SDP_API_BASE_URL;

  beforeEach(() => {
    process.env.SDP_API_BASE_URL = "https://api.example.test";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.cookies.mockReset();
    mocks.auth.mockReset();

    if (originalApiBaseUrl === undefined) {
      delete process.env.SDP_API_BASE_URL;
    } else {
      process.env.SDP_API_BASE_URL = originalApiBaseUrl;
    }
  });

  it("reuses one Clerk token while preserving org and project scoping", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) =>
        name === "sdp_selected_project_id" ? { value: "project_test" } : undefined,
    });
    const getToken = vi.fn().mockResolvedValue("token_test");
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({
      getToken,
    });

    expect(projectClient).not.toBeNull();
    await organizationClient.fetch("/v1/onboarding/status");
    await projectClient?.fetch("/v1/wallets");

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const organizationHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const projectHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(organizationHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(organizationHeaders.has("x-project-id")).toBe(false);
    expect(projectHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(projectHeaders.get("x-project-id")).toBe("project_test");
  });

  it("still returns an org client when no project is selected", async () => {
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    const getToken = vi.fn().mockResolvedValue("token_test");

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({
      getToken,
    });

    expect(organizationClient).toBeDefined();
    expect(projectClient).toBeNull();
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  // The three cases above all hand in `getToken`, which is the branch callers are
  // being moved off. These cover the default one the migrated pages now take.
  it("takes the token and project from the request when no getToken is passed", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) =>
        name === "sdp_selected_project_id" ? { value: "project_test" } : undefined,
    });
    const getToken = vi.fn().mockResolvedValue("token_from_request");
    mocks.auth.mockResolvedValue({ getToken, orgId: "org_test" });
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();

    expect(projectClient).not.toBeNull();
    await organizationClient.fetch("/v1/onboarding/status");
    await projectClient?.fetch("/v1/wallets");

    // One mint covering both clients is the whole point of the request-scoped branch.
    expect(getToken).toHaveBeenCalledTimes(1);

    const organizationHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const projectHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(organizationHeaders.get("Authorization")).toBe("Bearer token_from_request");
    expect(organizationHeaders.has("x-project-id")).toBe(false);
    expect(projectHeaders.get("Authorization")).toBe("Bearer token_from_request");
    expect(projectHeaders.get("x-project-id")).toBe("project_test");
  });

  it("returns a null project client when the request carries no selection", async () => {
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    mocks.auth.mockResolvedValue({
      getToken: vi.fn().mockResolvedValue("token_from_request"),
      orgId: "org_test",
    });

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();

    expect(organizationClient).toBeDefined();
    expect(projectClient).toBeNull();
  });

  it("refuses to build a client when the request has no active organization", async () => {
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    mocks.auth.mockResolvedValue({ getToken: vi.fn(), orgId: null });

    await expect(createRequestScopedSdpApiClients()).rejects.toThrow(
      "Active Clerk organization required"
    );
  });

  it("preserves upstream status on API response errors", async () => {
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("temporarily unavailable", { status: 503 }))
    );

    const { organizationClient } = await createRequestScopedSdpApiClients({
      getToken: vi.fn().mockResolvedValue("token_test"),
    });

    const request = organizationClient.fetch("/v1/projects");
    await expect(request).rejects.toBeInstanceOf(SdpApiResponseError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });

  it("forwards only explicitly supplied endpoint headers to the upstream request", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) =>
        name === "sdp_selected_project_id" ? { value: "project_test" } : undefined,
    });
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://dashboard.example.test/api/deposit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Inbound-Only": "must-not-leak",
      },
      body: JSON.stringify({ amount: "1" }),
    });

    const response = await proxyToSdpApi({
      request,
      traceSource: "test.proxy.headers",
      path: "/v1/earn/vault-deposits",
      upstreamHeaders: { "Idempotency-Key": "deposit-key" },
    });

    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(headers.has("X-Inbound-Only")).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer token_test");
    expect(headers.get("x-project-id")).toBe("project_test");
    expect(options?.body).toBe(JSON.stringify({ amount: "1" }));
  });

  it("rejects a write captured for a different project before reaching the API", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) =>
        name === "sdp_selected_project_id" ? { value: "project_next" } : undefined,
    });
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToSdpApi({
      request: new Request("https://dashboard.example.test/api/button-configuration", {
        method: "PUT",
      }),
      traceSource: "test.proxy.project_guard",
      path: "/v1/earn/button-configurations/current",
      expectedProjectId: "project_original",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Project selection changed. Reload and try again." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit project identity when a route enables the project guard", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) =>
        name === "sdp_selected_project_id" ? { value: "project_current" } : undefined,
    });
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToSdpApi({
      request: new Request("https://dashboard.example.test/api/button-configuration", {
        method: "PUT",
      }),
      traceSource: "test.proxy.project_guard",
      path: "/v1/earn/button-configurations/current",
      expectedProjectId: "",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Expected project required" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
