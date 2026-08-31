import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("Embedded Yield redirects", () => {
  it("temporarily redirects every legacy dashboard child route", async () => {
    const redirects = await nextConfig.redirects?.();

    expect(redirects).toContainEqual({
      source: "/dashboard/markets/earn/:path*",
      destination: "/dashboard/markets/embedded-yield/:path*",
      permanent: false,
    });
  });

  it("permanently redirects public handoff links", async () => {
    const redirects = await nextConfig.redirects?.();

    expect(redirects).toContainEqual({
      source: "/earn/integrate/:token",
      destination: "/embedded-yield/integrate/:token",
      permanent: true,
    });
  });
});
