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

import { GET as getWallets } from "./route";

const PROJECT_COOKIE = "sdp_selected_project_id";

const organizationProjects = [
  { id: "project_sandbox", slug: "default-sandbox" },
  { id: "project_test", slug: "project-test" },
];

function cookieJar(projectId?: string) {
  return {
    get: (name: string) =>
      name === PROJECT_COOKIE && projectId ? { value: projectId } : undefined,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function apiFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/v1/projects")) {
      return Response.json({ data: { projects: organizationProjects } });
    }
    return Response.json({ data: { wallets: [] } });
  });
}

describe("GET /api/dashboard/wallets explicit project binding", () => {
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

  it("pins an explicitly requested project even while the cookie names another", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_other"));
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getWallets(
      new Request(
        "https://dashboard.example.test/api/dashboard/wallets?view=summary&includeBalances=true&projectId=project_test"
      )
    );

    expect(response.status).toBe(200);
    const walletsCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/v1/wallets")
    );
    expect(walletsCalls).toHaveLength(1);
    const headers = new Headers(walletsCalls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe("project_test");
    // The project parameter is dashboard-owned and never forwarded upstream.
    expect(requestUrl(walletsCalls[0]?.[0])).not.toContain("projectId=");
  });

  it("refuses an explicitly requested project the organization does not list", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getWallets(
      new Request(
        "https://dashboard.example.test/api/dashboard/wallets?view=summary&projectId=project_unlisted"
      )
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Requested project is not available for this organization");
    // Fail closed: nothing but the validating project list may reach upstream.
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/v1/wallets"))
    ).toHaveLength(0);
  });

  it("resolves the project from the selection cookie when the request names none", async () => {
    mocks.cookies.mockResolvedValue(cookieJar("project_test"));
    const fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getWallets(
      new Request("https://dashboard.example.test/api/dashboard/wallets?view=summary")
    );

    expect(response.status).toBe(200);
    const walletsCalls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/v1/wallets")
    );
    const headers = new Headers(walletsCalls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe("project_test");
  });
});
