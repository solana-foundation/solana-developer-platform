/**
 * Payment-request creation must be bound to the render scope of the page that
 * rendered the form (APE-706 / SOLA9-424): the BFF rereads the shared
 * `sdp_selected_project_id` cookie when the create is submitted, so a tab that
 * rendered under project A could previously persist its request under project
 * B after a sibling tab moved the shared cookie. The route has to refuse any
 * create whose sealed render scope is missing, invalid, or bound to a project
 * other than the current cookie-derived selection.
 *
 * The seal/verify cryptography itself is covered in
 * `lib/render-scope.unit.test.ts`; these tests pin the route wiring and the
 * fail-closed verdicts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  getSelectedProjectId: vi.fn(),
  proxyFailure: vi.fn(),
  createTimedTrace: vi.fn(),
  logRouteResult: vi.fn(),
  auth: vi.fn(),
  sealRenderScope: vi.fn(),
  verifyRenderScope: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
  getSelectedProjectId: mocks.getSelectedProjectId,
  proxyFailure: mocks.proxyFailure,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: mocks.createTimedTrace,
  logRouteResult: mocks.logRouteResult,
}));

vi.mock("@/lib/render-scope", () => ({
  RENDER_SCOPE_HEADER_NAME: "x-sdp-render-scope",
  sealRenderScope: mocks.sealRenderScope,
  verifyRenderScope: mocks.verifyRenderScope,
}));

import { POST } from "./route";

const SESSION = { sessionId: "sess_render", userId: "usr_render" };
const OTHER_SESSION = { sessionId: "sess_other", userId: "usr_render" };
const RENDER_SCOPE_HEADER = "x-sdp-render-scope";
const TRACE_SOURCE = "route.dashboard.payment-requests.create";

function renderScopeToken(projectId: string, sessionId: string = SESSION.sessionId): string {
  return JSON.stringify({ projectId, sid: sessionId });
}

/**
 * Test double mirroring the real `verifyRenderScope` contract: the sealed
 * token records the project it was minted for and the Clerk session that
 * minted it; verification fails closed unless both match.
 */
function implementVerifyDouble(): void {
  mocks.verifyRenderScope.mockImplementation(
    async (
      sealed: string | null,
      claims: { sessionId: string | null; userId: string | null },
      expectedProjectId: string
    ) => {
      if (!claims.sessionId || !claims.userId) {
        return { ok: false as const, reason: "unauthenticated" as const };
      }
      if (typeof sealed !== "string" || sealed.length === 0) {
        return { ok: false as const, reason: "missing" as const };
      }
      try {
        const scope = JSON.parse(sealed) as { projectId?: string; sid?: string };
        if (scope.sid !== claims.sessionId) {
          return { ok: false as const, reason: "invalid" as const };
        }
        if (scope.projectId !== expectedProjectId) {
          return { ok: false as const, reason: "project_mismatch" as const };
        }
        return { ok: true as const, projectId: expectedProjectId };
      } catch {
        return { ok: false as const, reason: "invalid" as const };
      }
    }
  );
}

async function expectRejected(
  response: Response,
  status: number,
  message: string,
  code: string
): Promise<void> {
  expect(response.status).toBe(status);
  expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toEqual({ error: { code, message } });
}

describe("POST /api/dashboard/payments/requests render-scope binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(SESSION);
    mocks.getSelectedProjectId.mockResolvedValue("prj_rendered");
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 202 }));
    mocks.proxyFailure.mockImplementation(
      (_trace: unknown, status: number, message: string, code?: string) =>
        new Response(JSON.stringify({ error: { ...(code ? { code } : {}), message } }), {
          status,
          headers: { "content-type": "application/json" },
        })
    );
    mocks.createTimedTrace.mockReturnValue({
      traceId: "web_test_trace",
      source: TRACE_SOURCE,
      elapsedMs: () => 0,
    });
    implementVerifyDouble();
  });

  // Security regression (APE-706 / SOLA9-424): the create used to be proxied
  // with whatever project the shared cookie pointed at submit time.
  it("rejects creation when the render scope is bound to a different project", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("prj_sibling");
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: renderScopeToken("prj_rendered") },
      body: JSON.stringify({
        walletId: "wal_1",
        token: "So11111111111111111111111111111111111111112",
        amount: "1.25",
      }),
    });

    const response = await POST(request);

    expectRejected(
      response,
      409,
      "Project selection changed. Reload the page and try again.",
      "render_scope_project_mismatch"
    );
    expect(mocks.verifyRenderScope).toHaveBeenCalledWith(
      renderScopeToken("prj_rendered"),
      SESSION,
      "prj_sibling"
    );
  });

  it("rejects creation when the render-scope header is missing", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
    });

    const response = await POST(request);

    expectRejected(
      response,
      409,
      "This page is out of date. Reload the page and try again.",
      "render_scope_stale"
    );
  });

  it("rejects creation when the render scope is not a valid sealed token", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: "not-a-sealed-render-scope" },
    });

    const response = await POST(request);

    expectRejected(
      response,
      409,
      "This page is out of date. Reload the page and try again.",
      "render_scope_stale"
    );
  });

  it("rejects creation when the render scope was minted for another Clerk session", async () => {
    mocks.auth.mockResolvedValue(OTHER_SESSION);
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: renderScopeToken("prj_rendered") },
    });

    const response = await POST(request);

    expectRejected(
      response,
      409,
      "This page is out of date. Reload the page and try again.",
      "render_scope_stale"
    );
  });

  it("rejects creation when the render scope has expired", async () => {
    mocks.verifyRenderScope.mockResolvedValue({ ok: false, reason: "invalid" });
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: renderScopeToken("prj_rendered") },
    });

    const response = await POST(request);

    expectRejected(
      response,
      409,
      "This page is out of date. Reload the page and try again.",
      "render_scope_stale"
    );
  });

  it("returns 401 without proxying when the request carries no session", async () => {
    mocks.auth.mockResolvedValue({ sessionId: null, userId: null });
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
    });

    const response = await POST(request);

    expectRejected(response, 401, "Authentication required", "authentication_required");
  });

  it("creates the request when the render scope matches the current selection", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: renderScopeToken("prj_rendered") },
      body: JSON.stringify({ walletId: "wal_1", amount: "1.25" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(mocks.verifyRenderScope).toHaveBeenCalledWith(
      renderScopeToken("prj_rendered"),
      SESSION,
      "prj_rendered"
    );
    expect(mocks.proxyToSdpApi).toHaveBeenCalledTimes(1);
    const call = mocks.proxyToSdpApi.mock.calls[0]?.[0] as {
      request: Request;
      traceSource: string;
    };
    expect(call.request).toBe(request);
    expect(call.traceSource).toBe(TRACE_SOURCE);
  });

  it("does not require a render scope when no project is selected", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(undefined);
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(mocks.verifyRenderScope).not.toHaveBeenCalled();
    expect(mocks.proxyToSdpApi).toHaveBeenCalledTimes(1);
  });

  it("never forwards the render-scope header upstream", async () => {
    const request = new Request("https://dashboard.example/api/dashboard/payments/requests", {
      method: "POST",
      headers: { [RENDER_SCOPE_HEADER]: renderScopeToken("prj_rendered") },
    });

    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledTimes(1);
    const call = mocks.proxyToSdpApi.mock.calls[0]?.[0] as {
      upstreamHeaders?: HeadersInit;
    };
    expect(call.upstreamHeaders).toBeUndefined();
  });
});
