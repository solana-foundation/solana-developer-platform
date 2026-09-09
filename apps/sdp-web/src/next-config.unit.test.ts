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

  it("no longer redirects the removed public handoff links", async () => {
    const redirects = await nextConfig.redirects?.();

    // The public engineering-handoff pages left with the UI builder; a
    // redirect whose destination 404s would just move the dead end around.
    expect(redirects?.some((redirect) => redirect.source === "/earn/integrate/:token")).toBe(false);
  });
});
