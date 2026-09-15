import { describe, expect, it } from "vitest";
import {
  APPROVAL_ACTIONS,
  buildApprovalActionPath,
  classifyApprovalActionResponse,
  isApprovalAction,
  readApprovalActionResponse,
} from "./approval-actions";

describe("approval actions", () => {
  it.each(APPROVAL_ACTIONS)("builds the %s endpoint", (action) => {
    expect(buildApprovalActionPath("request/one", action)).toBe(
      `/api/dashboard/approval-requests/request%2Fone/${action}`
    );
    expect(isApprovalAction(action)).toBe(true);
  });

  it("rejects unsupported actions", () => {
    expect(isApprovalAction("archive")).toBe(false);
  });

  it("classifies an authoritative updated request as success", () => {
    expect(classifyApprovalActionResponse(200)).toBe("success");
    expect(classifyApprovalActionResponse(204)).toBe("success");
  });

  it("classifies already-decided and forbidden responses", () => {
    expect(classifyApprovalActionResponse(409)).toBe("stale");
    expect(classifyApprovalActionResponse(403)).toBe("forbidden");
  });

  it("distinguishes wallet availability refusals from permission and decision conflicts", () => {
    expect(classifyApprovalActionResponse(403, "runtime_execution_paused")).toBe("runtime_paused");
    expect(classifyApprovalActionResponse(409, "runtime_execution_unavailable")).toBe(
      "runtime_unavailable"
    );
    expect(classifyApprovalActionResponse(403, "provider_not_entitled")).toBe(
      "provider_not_entitled"
    );
    expect(classifyApprovalActionResponse(500, "provider_not_entitled")).toBe("failure");
    expect(classifyApprovalActionResponse(403, "other_reason")).toBe("forbidden");
    expect(classifyApprovalActionResponse(409, "other_reason")).toBe("stale");
    expect(classifyApprovalActionResponse(200, "runtime_execution_paused")).toBe("success");
    expect(classifyApprovalActionResponse(500, "runtime_execution_unavailable")).toBe("failure");
  });
});

describe("readApprovalActionResponse", () => {
  const approvalRequest = {
    id: "apr_1",
    status: "approved",
    viewerIsRequester: false,
    operation: {
      status: "failed",
      executionCompletedAt: "2026-09-11T10:05:00.000Z",
      executionError: "Provider quote/session reference has expired; create a new quote.",
    },
  };

  it("returns the request from a successful response", async () => {
    const result = await readApprovalActionResponse(Response.json({ data: { approvalRequest } }));
    expect(result).toEqual({ ok: true, approvalRequest });
  });

  it("returns no request when a successful body does not carry a valid one", async () => {
    for (const body of [
      { data: {} },
      { data: { approvalRequest: { ...approvalRequest, status: "done" } } },
      { data: { approvalRequest: { ...approvalRequest, operation: { status: "failed" } } } },
    ]) {
      expect(await readApprovalActionResponse(Response.json(body))).toEqual({
        ok: true,
        approvalRequest: null,
      });
    }
    expect(await readApprovalActionResponse(new Response("not json", { status: 200 }))).toEqual({
      ok: true,
      approvalRequest: null,
    });
  });

  it("keeps the API's message and reason from an error response", async () => {
    expect(
      await readApprovalActionResponse(
        Response.json(
          {
            error: {
              message: "Runtime refusal",
              details: { reason: "runtime_execution_paused" },
            },
          },
          { status: 403 }
        )
      )
    ).toEqual({
      ok: false,
      status: 403,
      message: "Runtime refusal",
      reason: "runtime_execution_paused",
    });
    expect(
      await readApprovalActionResponse(Response.json({ error: "Upstream failed" }, { status: 502 }))
    ).toEqual({ ok: false, status: 502, message: "Upstream failed", reason: undefined });
    expect(await readApprovalActionResponse(new Response("<html>", { status: 500 }))).toEqual({
      ok: false,
      status: 500,
      message: null,
      reason: undefined,
    });
  });
});
