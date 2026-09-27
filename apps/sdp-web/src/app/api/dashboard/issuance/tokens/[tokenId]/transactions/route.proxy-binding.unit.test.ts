// Regression test for SOLA9-564 (APE-818) review follow-up: the token-detail
// read routes are project-context aware, so the rendered context must bind the
// upstream read, an unlisted context must answer 403 (the caller's answer being
// wrong), and a project list that cannot be loaded must answer 500 (this
// server failing) — never a cookie fallback for either.
//
// The route pipeline is real (route handler -> createContextBoundSdpApiClient
// -> upstream fetch); only cookies, Clerk auth and the network are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));

import { GET } from "./route";

const COOKIE_PROJECT = "project_cookie_tab_b";
const RENDERED_PROJECT = "project_rendered_tab_a";

const organizationProjects = [
  { id: RENDERED_PROJECT, slug: "default-sandbox" },
  { id: COOKIE_PROJECT, slug: "default-production" },
];

const PROJECT_COOKIE = "sdp_selected_project_id";
const PROJECT_CONTEXT_HEADER = "x-sdp-project-context";

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

function apiFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/v1/projects")) {
      return jsonResponse({ data: { projects: organizationProjects } });
    }
    return jsonResponse({
      data: [],
      meta: { total: 0, hasMore: false },
    });
  });
}

function transactionsRequest(contextProjectId?: string): Request {
  return new Request(
    "https://dashboard.example.com/api/dashboard/issuance/tokens/tok_1/transactions",
    {
      method: "GET",
      headers: contextProjectId ? { [PROJECT_CONTEXT_HEADER]: contextProjectId } : {},
    }
  );
}

describe("GET /api/dashboard/issuance/tokens/[tokenId]/transactions project context binding", () => {
  const originalApiBaseUrl = process.env.SDP_API_BASE_URL;
  let fetchMock: ReturnType<typeof apiFetchMock>;

  beforeEach(() => {
    process.env.SDP_API_BASE_URL = "https://api.example.test";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({
      userId: "user_test",
      orgId: "org_test",
      getToken: vi.fn().mockResolvedValue("token_test"),
    });
    fetchMock = apiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
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

  function upstreamTransactionsCalls(): Array<[RequestInfo | URL, RequestInit?]> {
    return fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/v1/issuance/tokens/tok_1/transactions")
    );
  }

  it("binds the upstream read to the rendered project context, not the shared cookie", async () => {
    // A sibling tab flipped the shared cookie to project B; the stale tab still
    // renders project A and must keep reading A.
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await GET(transactionsRequest(RENDERED_PROJECT), {
      params: Promise.resolve({ tokenId: "tok_1" }),
    });

    expect(response.status).toBe(200);
    const calls = upstreamTransactionsCalls();
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe(RENDERED_PROJECT);
  });

  it("answers 403 without an upstream read when the rendered context is not listed", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await GET(transactionsRequest("project_not_in_this_org"), {
      params: Promise.resolve({ tokenId: "tok_1" }),
    });

    expect(response.status).toBe(403);
    expect(upstreamTransactionsCalls()).toHaveLength(0);
    expect(await response.json()).toMatchObject({
      error: "Requested project is not available for this organization",
    });
  });

  it("answers 500 without an upstream read when the project list cannot be loaded", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/projects")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return jsonResponse({ data: [], meta: { total: 0, hasMore: false } });
    });

    const response = await GET(transactionsRequest(RENDERED_PROJECT), {
      params: Promise.resolve({ tokenId: "tok_1" }),
    });

    expect(response.status).toBe(500);
    expect(upstreamTransactionsCalls()).toHaveLength(0);
  });

  it("keeps the cookie-based project for requests without a rendered context", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await GET(transactionsRequest(), {
      params: Promise.resolve({ tokenId: "tok_1" }),
    });

    expect(response.status).toBe(200);
    const calls = upstreamTransactionsCalls();
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe(COOKIE_PROJECT);
  });
});
