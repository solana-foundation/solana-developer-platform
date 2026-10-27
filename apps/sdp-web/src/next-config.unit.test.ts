import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

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

describe("Docs proxy rewrites", () => {
  it.each([
    ["/llms.txt", "/docs/ai/llms.txt"],
    ["/llms-full.txt", "/docs/ai/llms-full.txt"],
    ["/docs.md", "/docs.md"],
  ])("serves %s from the docs app's %s", async (source, docsPath) => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toContainEqual({
      source,
      destination: expect.stringMatching(new RegExp(`^https?://[^/]+${docsPath}$`)),
    });
  });
});
