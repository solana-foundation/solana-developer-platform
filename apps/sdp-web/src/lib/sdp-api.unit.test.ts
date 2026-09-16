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

import {
  createRequestScopedSdpApiClients,
  createSdpApiClient,
  proxyToSdpApi,
  SdpApiResponseError,
} from "./sdp-api";

const PROJECT_COOKIE = "sdp_selected_project_id";

const organizationProjects = [
  { id: "project_sandbox", slug: "default-sandbox" },
  { id: "project_test", slug: "default-production" },
];

function cookieJar(projectId?: string) {
  return {
    get: (name: string) =>
      name === PROJECT_COOKIE && projectId ? { value: projectId } : undefined,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The client now validates the project cookie against `/v1/projects` before
 * scoping a request, so every fetch mock answers that list explicitly and the
 * assertions below find the call under test by path rather than by position.
 */
function apiFetchMock({
  projects = organizationProjects,
  respond = () => jsonResponse({ data: { ok: true } }),
}: {
  projects?: Array<{ id: string; slug: string }> | (() => Response);
  respond?: (url: string, init?: RequestInit) => Response;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/v1/projects")) {
      return typeof projects === "function" ? projects() : jsonResponse({ data: { projects } });
    }
    return respond(url, init);
  });
}

function callsTo(fetchMock: ReturnType<typeof apiFetchMock>, path: string) {
  return fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith(path));
}

function headersOf(call: [RequestInfo | URL, RequestInit?] | undefined) {
  return new Headers(call?.[1]?.headers);
}

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
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    const getToken = vi.fn().mockResolvedValue("token_test");
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({
      getToken,
    });

    expect(projectClient).not.toBeNull();
    await organizationClient.fetch("/v1/onboarding/status");
    await projectClient?.fetch("/v1/wallets");

    expect(getToken).toHaveBeenCalledTimes(1);
    // The validating list read rides on the same explicit token: no second mint.
    const projectListHeaders = headersOf(callsTo(fetchMock, "/v1/projects")[0]);
    expect(projectListHeaders.get("Authorization")).toBe("Bearer token_test");

    const organizationHeaders = headersOf(callsTo(fetchMock, "/v1/onboarding/status")[0]);
    const projectHeaders = headersOf(callsTo(fetchMock, "/v1/wallets")[0]);
    expect(organizationHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(organizationHeaders.has("x-project-id")).toBe(false);
    expect(projectHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(projectHeaders.get("x-project-id")).toBe("project_test");
  });

  it("still returns an org client when no project is selected", async () => {
    mocks.cookies.mockResolvedValue(cookieJar());
    const getToken = vi.fn().mockResolvedValue("token_test");
    vi.stubGlobal("fetch", apiFetchMock({ projects: [] }));

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({
      getToken,
    });

    expect(organizationClient).toBeDefined();
    expect(projectClient).toBeNull();
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  // The cases above all hand in `getToken`, which is the branch callers are
  // being moved off. These cover the default one the migrated pages now take.
  it("takes the token and project from the request when no getToken is passed", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    const getToken = vi.fn().mockResolvedValue("token_from_request");
    mocks.auth.mockResolvedValue({ getToken, orgId: "org_test" });
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();

    expect(projectClient).not.toBeNull();
    await organizationClient.fetch("/v1/onboarding/status");
    await projectClient?.fetch("/v1/wallets");

    // One mint covering both clients is the whole point of the request-scoped branch.
    expect(getToken).toHaveBeenCalledTimes(1);

    const projectListHeaders = headersOf(callsTo(fetchMock, "/v1/projects")[0]);
    const organizationHeaders = headersOf(callsTo(fetchMock, "/v1/onboarding/status")[0]);
    const projectHeaders = headersOf(callsTo(fetchMock, "/v1/wallets")[0]);
    // The validating list read is itself org-scoped: it must never carry the
    // cookie it is about to check.
    expect(projectListHeaders.has("x-project-id")).toBe(false);
    expect(organizationHeaders.get("Authorization")).toBe("Bearer token_from_request");
    expect(organizationHeaders.has("x-project-id")).toBe(false);
    expect(projectHeaders.get("Authorization")).toBe("Bearer token_from_request");
    expect(projectHeaders.get("x-project-id")).toBe("project_test");
  });

  it("returns a null project client when the organization has no projects", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_stale"));
    mocks.auth.mockResolvedValue({
      getToken: vi.fn().mockResolvedValue("token_from_request"),
      orgId: "org_test",
    });
    vi.stubGlobal("fetch", apiFetchMock({ projects: [] }));

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();

    expect(organizationClient).toBeDefined();
    expect(projectClient).toBeNull();
    await expect(createSdpApiClient()).rejects.toThrow("Selected project required");
  });

  it("refuses to build a client when the request has no active organization", async () => {
    mocks.cookies.mockResolvedValue(cookieJar());
    mocks.auth.mockResolvedValue({ getToken: vi.fn(), orgId: null });

    await expect(createRequestScopedSdpApiClients()).rejects.toThrow(
      "Active Clerk organization required"
    );
  });

  it("preserves upstream status on API response errors", async () => {
    mocks.cookies.mockResolvedValue(cookieJar());
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
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
    const fetchMock = apiFetchMock({ respond: () => new Response(null, { status: 204 }) });
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const upstreamCalls = callsTo(fetchMock, "/v1/earn/vault-deposits");
    expect(upstreamCalls).toHaveLength(1);
    const [, options] = upstreamCalls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(headers.has("X-Inbound-Only")).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer token_test");
    expect(headers.get("x-project-id")).toBe("project_test");
    expect(options?.body).toBe(JSON.stringify({ amount: "1" }));
  });

  it("marks proxy failure responses uncacheable too", async () => {
    mocks.cookies.mockResolvedValue(cookieJar());
    mocks.auth.mockResolvedValue({ userId: null, orgId: null, getToken: vi.fn() });

    const response = await proxyToSdpApi({
      request: new Request("https://dashboard.example.test/api/anything", {
        method: "POST",
        body: "{}",
      }),
      traceSource: "test.proxy.cache",
      path: "/v1/earn/vault-deposits",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

// A cookie can name a project this organization does not list: two local stacks
// sharing `localhost` cookies, an archived project, a revoked membership. The
// layout already falls back to the sandbox for that render; the client the pages
// under it read with must land on the same project, or the API answers 403 and
// the page throws into the error boundary beside a shell that looks fine.
describe("createSdpApiClient project resolution", () => {
  const originalApiBaseUrl = process.env.SDP_API_BASE_URL;

  beforeEach(() => {
    process.env.SDP_API_BASE_URL = "https://api.example.test";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
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

  it("sends the sandbox project when the cookie names a project outside the organization", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_stale"));
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const client = await createSdpApiClient();
    await client.fetch("/v1/api-keys");

    const headers = headersOf(callsTo(fetchMock, "/v1/api-keys")[0]);
    expect(headers.get("x-project-id")).toBe("project_sandbox");
  });

  it("sends the sandbox project when the cookie is missing", async () => {
    mocks.cookies.mockResolvedValue(cookieJar());
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const client = await createSdpApiClient();
    await client.fetch("/v1/api-keys");

    const headers = headersOf(callsTo(fetchMock, "/v1/api-keys")[0]);
    expect(headers.get("x-project-id")).toBe("project_sandbox");
  });

  it("keeps a listed cookie project ahead of the sandbox", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const client = await createSdpApiClient();
    await client.fetch("/v1/api-keys");

    const headers = headersOf(callsTo(fetchMock, "/v1/api-keys")[0]);
    expect(headers.get("x-project-id")).toBe("project_test");
  });

  it("does not select production on the customer's behalf when there is no sandbox", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_stale"));
    vi.stubGlobal(
      "fetch",
      apiFetchMock({ projects: [{ id: "project_production", slug: "default-production" }] })
    );

    // The layout renders this case as "no project selected"; the client must agree
    // rather than quietly read production.
    await expect(createSdpApiClient()).rejects.toThrow("Selected project required");
  });

  it("keeps the cookie's project when the project list cannot be loaded", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_stale"));
    const fetchMock = apiFetchMock({
      projects: () => new Response("temporarily unavailable", { status: 503 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = await createSdpApiClient();
    await client.fetch("/v1/api-keys");

    // Nothing to validate against, so the cookie's word stands, the same way the
    // layout treats a failed list load as non-authoritative.
    const headers = headersOf(callsTo(fetchMock, "/v1/api-keys")[0]);
    expect(headers.get("x-project-id")).toBe("project_stale");
  });
});
