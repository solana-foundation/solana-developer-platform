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

describe("Security headers", () => {
  async function headersFor(source: string): Promise<Map<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((entry) => entry.source === source);
    if (!rule) {
      throw new Error(`No header rule for ${source}`);
    }
    return new Map(rule.headers.map((header) => [header.key, header.value]));
  }

  it("sends a baseline CSP that closes the sinks no page uses, on every route", async () => {
    const baseline = await headersFor("/:path*");

    expect(baseline.get("Content-Security-Policy")).toBe("base-uri 'none'; object-src 'none'");
    expect(baseline.get("X-Content-Type-Options")).toBe("nosniff");
    expect(baseline.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(baseline.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });

  it.each(["/dashboard/:path*", "/api/:path*"])(
    "keeps %s unframeable by other origins",
    async (source) => {
      const scoped = await headersFor(source);

      expect(scoped.get("Content-Security-Policy")).toBe(
        "base-uri 'none'; object-src 'none'; frame-ancestors 'self'"
      );
      expect(scoped.get("X-Frame-Options")).toBe("SAMEORIGIN");
    }
  );

  it("leaves the public /pay/:token request page embeddable, outside the frame rules", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const frameAncestorsSources = rules
      .filter((rule) =>
        rule.headers.some(
          (header) =>
            header.key === "Content-Security-Policy" && header.value.includes("frame-ancestors")
        )
      )
      .map((rule) => rule.source);

    // /pay/:token must stay embeddable for issuers, so the frame rules cover
    // exactly the dashboard and the BFF.
    expect(frameAncestorsSources).toEqual(["/dashboard/:path*", "/api/:path*"]);
  });
});
