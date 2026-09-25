// @vitest-environment node
/**
 * The create route's project binding (APE-693 / SOLA9-200).
 *
 * The create page renders under one project, but the shared selection cookie is
 * mutable while the wizard is mounted: without a binding, a form reviewed under
 * project A could be submitted after the selection moved to sibling project B,
 * and the proxy would forward it with B's project header — recording custody,
 * sponsorship and the trade itself under a project whose terms were never
 * reviewed. The route therefore requires the reviewed project to ride with the
 * request and refuses to forward anything that does not match the current
 * selection.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  getSelectedProjectId: vi.fn(),
}));

// Mirrors the real `proxyFailure` closely enough for the refusals' envelope:
// status and body shape are what this route's contract is about.
vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
  getSelectedProjectId: mocks.getSelectedProjectId,
  proxyFailure: (_trace: unknown, status: number, message: string, details?: { reason: string }) =>
    NextResponse.json({ error: { message, ...(details ? { details } : {}) } }, { status }),
}));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: vi.fn(() => ({
    traceId: "trace_test",
    serverTiming: () => "t;dur=0",
    childContext: () => ({}),
    elapsedMs: () => 0,
  })),
  logRouteResult: vi.fn(),
}));

import { POST } from "./route";

const REVIEWED = "x-sdp-reviewed-project-id";

function createRequest(headers: Record<string, string>): Request {
  return new Request("https://dashboard.example/api/dashboard/markets/dvp/trades", {
    method: "POST",
    headers,
    body: JSON.stringify({ partyA: { address: "a" }, partyB: { address: "b" } }),
  });
}

describe("POST /api/dashboard/markets/dvp/trades", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 201 }));
  });

  it("rejects a create whose reviewed project differs from the current selection", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("project_b");

    const response = await POST(
      createRequest({
        [REVIEWED]: "project_a",
        "Idempotency-Key": "dvp-create-abc",
      })
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error?: { message?: string; details?: { reason?: string } };
    };
    expect(body.error?.message).toBeTruthy();
    // The form names this refusal in its own words from the code, so the
    // message never has to be parsed.
    expect(body.error?.details?.reason).toBe("dvp_create_reviewed_project_mismatch");
    // Nothing may reach the API: the trade would be recorded under project_b.
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });

  it("rejects a create that presents no reviewed project", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("project_b");

    const response = await POST(createRequest({ "Idempotency-Key": "dvp-create-abc" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: { message?: string; details?: { reason?: string } };
    };
    expect(body.error?.details?.reason).toBe("dvp_create_reviewed_project_required");
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });

  it("rejects a create when no project is selected at all", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(undefined);

    const response = await POST(createRequest({ [REVIEWED]: "project_a" }));

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });

  it("forwards a create whose reviewed project matches the selection", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("project_a");

    const request = createRequest({
      [REVIEWED]: "project_a",
      "Idempotency-Key": "dvp-create-abc",
    });
    await POST(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        path: "/v1/dvp/trades",
        // The key still rides upstream; the binding header must not.
        upstreamHeaders: { "Idempotency-Key": "dvp-create-abc" },
      })
    );
  });
});
