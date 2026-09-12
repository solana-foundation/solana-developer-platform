import { describe, expect, it } from "vitest";
import {
  APPROVAL_ACTIONS,
  buildApprovalActionPath,
  classifyApprovalActionResponse,
  isApprovalAction,
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
