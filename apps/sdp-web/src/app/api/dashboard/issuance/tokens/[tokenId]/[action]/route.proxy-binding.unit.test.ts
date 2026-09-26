// Regression test for SOLA9-564 (APE-818): dashboard issuance actions must
// execute under the project context the surface was rendered with, not under
// the host-wide `sdp_selected_project_id` cookie a sibling tab can flip
// between render and submit.
//
// The route pipeline is real (route handler -> proxyToSdpApi -> upstream
// fetch); only cookies, Clerk auth and the network are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));

import { POST } from "./route";

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
    return jsonResponse({ data: { ok: true } });
  });
}

function mintRequest(contextProjectId?: string): Request {
  return new Request("https://dashboard.example.com/api/dashboard/issuance/tokens/tok_1/mint", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(contextProjectId ? { [PROJECT_CONTEXT_HEADER]: contextProjectId } : {}),
    },
    body: JSON.stringify({ mint: { destination: "dest", amount: "1" } }),
  });
}

describe("POST /api/dashboard/issuance/tokens/[tokenId]/[action] project context binding", () => {
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

  function upstreamActionCalls(): Array<[RequestInfo | URL, RequestInit?]> {
    return fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/v1/issuance/tokens/tok_1/mint")
    );
  }

  it("binds the upstream action to the rendered project context, not the shared cookie", async () => {
    // A sibling tab flipped the shared cookie to project B; the stale tab still
    // renders project A and must keep executing under A.
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await POST(mintRequest(RENDERED_PROJECT), {
      params: Promise.resolve({ tokenId: "tok_1", action: "mint" }),
    });

    expect(response.status).toBe(200);
    const calls = upstreamActionCalls();
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe(RENDERED_PROJECT);
  });

  it("fails closed without executing the action when the rendered context is not listed", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await POST(mintRequest("project_not_in_this_org"), {
      params: Promise.resolve({ tokenId: "tok_1", action: "mint" }),
    });

    expect(response.status).toBe(403);
    expect(upstreamActionCalls()).toHaveLength(0);
  });

  it("fails closed without executing the action when the project list cannot be loaded", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/projects")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return jsonResponse({ data: { ok: true } });
    });

    const response = await POST(mintRequest(RENDERED_PROJECT), {
      params: Promise.resolve({ tokenId: "tok_1", action: "mint" }),
    });

    expect(response.status).toBe(500);
    expect(upstreamActionCalls()).toHaveLength(0);
  });

  it("keeps the cookie-based project for requests without a rendered context", async () => {
    mocks.cookies.mockResolvedValue(cookieJar(COOKIE_PROJECT));

    const response = await POST(mintRequest(), {
      params: Promise.resolve({ tokenId: "tok_1", action: "mint" }),
    });

    expect(response.status).toBe(200);
    const calls = upstreamActionCalls();
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("x-project-id")).toBe(COOKIE_PROJECT);
  });
});
