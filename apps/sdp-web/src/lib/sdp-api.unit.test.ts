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

import { createRequestScopedSdpApiClients, SdpApiResponseError } from "./sdp-api";

describe("createRequestScopedSdpApiClients", () => {
  const originalApiBaseUrl = process.env.SDP_API_BASE_URL;
  const originalClerkJwtTemplate = process.env.CLERK_JWT_TEMPLATE;

  beforeEach(() => {
    process.env.SDP_API_BASE_URL = "https://api.example.test";
    delete process.env.CLERK_JWT_TEMPLATE;
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

    if (originalClerkJwtTemplate === undefined) {
      delete process.env.CLERK_JWT_TEMPLATE;
    } else {
      process.env.CLERK_JWT_TEMPLATE = originalClerkJwtTemplate;
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
});
