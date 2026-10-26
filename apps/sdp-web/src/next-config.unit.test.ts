import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

async function headersFor(source: string): Promise<Record<string, string>> {
  const headers = await nextConfig.headers?.();
  const entry = headers?.find((rule) => rule.source === source);
  if (!entry) throw new Error(`no headers rule for ${source}`);
  return Object.fromEntries(entry.headers.map((header) => [header.key, header.value]));
}

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

describe("security headers", () => {
  it("pins the injection sinks that need no nonce on every route", async () => {
    const headers = await headersFor("/:path*");

    expect(headers["Content-Security-Policy"]).toBe("object-src 'none'; base-uri 'self'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it.each(["/dashboard/:path*", "/api/:path*"])(
    "keeps %s unembeddable in both the XFO and CSP forms",
    async (source) => {
      const headers = await headersFor(source);

      expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
      expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'self'");
    }
  );
});
