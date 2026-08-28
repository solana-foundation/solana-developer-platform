import { describe, expect, it } from "vitest";
import { earnButtonIntegrationPath } from "./earn-button-integration";

describe("earnButtonIntegrationPath", () => {
  it("builds the canonical Embedded Yield handoff path", () => {
    expect(earnButtonIntegrationPath("public/token")).toBe(
      "/embedded-yield/integrate/public%2Ftoken"
    );
  });
});
