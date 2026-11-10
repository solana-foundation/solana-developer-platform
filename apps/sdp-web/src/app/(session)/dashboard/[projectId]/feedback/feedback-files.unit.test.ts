import { describe, expect, it } from "vitest";
import { feedbackFromPath } from "./feedback-files";

describe("feedbackFromPath", () => {
  it("takes a dashboard path", () => {
    expect(feedbackFromPath("/dashboard/prj_1/payments")).toBe("/dashboard/prj_1/payments");
  });

  it.each([
    ["missing", undefined],
    ["repeated", ["/dashboard/prj_1", "/dashboard/prj_2"]],
    ["another site", "https://example.com/dashboard/prj_1"],
    ["protocol-relative", "//example.com/dashboard/prj_1"],
    ["a doubled slash inside", "/dashboard//example.com"],
    ["a backslash", "/dashboard/\\example.com"],
    ["a control character", "/dashboard/prj_1\n"],
    ["outside the dashboard", "/sign-in"],
    ["too long", `/dashboard/${"x".repeat(1024)}`],
  ])("refuses a value that is %s", (_label, value) => {
    expect(feedbackFromPath(value)).toBeNull();
  });
});
