import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("Embedded Yield redirects", () => {
  it.each([
    ["/dashboard/markets/earn/:path*", "/dashboard/markets/embedded-yield/:path*"],
    [
      "/dashboard/:projectId/markets/earn/:path*",
      "/dashboard/:projectId/markets/embedded-yield/:path*",
    ],
  ])("temporarily redirects %s", async (source, destination) => {
    const redirects = await nextConfig.redirects?.();

    expect(redirects).toContainEqual({ source, destination, permanent: false });
  });
});
