import { describe, expect, it } from "vitest";
import { HELIUS_RINGS_PACKAGE_NAME } from "./index";

describe("@sdp/helius-rings", () => {
  it("exports the package identifier", () => {
    expect(HELIUS_RINGS_PACKAGE_NAME).toBe("@sdp/helius-rings");
  });
});
