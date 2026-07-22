import { describe, expect, it } from "vitest";
import { normalizeWorkspaceReturnPath } from "./workspace-loading";

describe("normalizeWorkspaceReturnPath", () => {
  it("keeps dashboard destinations", () => {
    expect(normalizeWorkspaceReturnPath("/dashboard/wallets?tab=activity")).toBe(
      "/dashboard/wallets?tab=activity"
    );
  });

  it.each([
    undefined,
    "",
    "//example.com",
    "/sign-in",
    "/dashboard/../sign-in",
    ["/members"],
  ])("falls back for an unsafe destination: %j", (value) => {
    expect(normalizeWorkspaceReturnPath(value)).toBe("/dashboard");
  });
});
