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
});
