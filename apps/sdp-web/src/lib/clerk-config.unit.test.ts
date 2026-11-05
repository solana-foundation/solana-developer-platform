import { describe, expect, it } from "vitest";
import { signInHref } from "./clerk-config";

describe("signInHref", () => {
  it("carries the return path and its query as one encoded redirect_url", () => {
    expect(signInHref("/dashboard/prj_test_sandbox/payments?tab=x&view=list")).toBe(
      "/sign-in?redirect_url=%2Fdashboard%2Fprj_test_sandbox%2Fpayments%3Ftab%3Dx%26view%3Dlist"
    );
  });
});
