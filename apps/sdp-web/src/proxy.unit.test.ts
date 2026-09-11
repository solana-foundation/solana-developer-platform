import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicRoute, rejectCrossSiteWrite } from "./proxy";

describe("public web routes", () => {
  it("keeps the workspace loading transition available during bootstrap", () => {
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/workspace-loading"))).toBe(
      true
    );
    expect(
      isPublicRoute(new NextRequest("https://dashboard.example.com/api/workspace-status"))
    ).toBe(true);
  });

  it("keeps shareable payment checkout links unauthenticated", () => {
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/pay/public-token"))).toBe(
      true
    );
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/pay"))).toBe(false);
    expect(
      isPublicRoute(new NextRequest("https://dashboard.example.com/pay/public-token/internal"))
    ).toBe(false);
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/pay/admin/settings"))).toBe(
      false
    );
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/dashboard/payments"))).toBe(
      false
    );
  });

  it("keeps the removed Embedded Yield handoff routes authenticated", () => {
    // The public engineering-handoff pages left with the UI builder; nothing
    // under these paths may be reachable without a session again.
    expect(
      isPublicRoute(
        new NextRequest("https://dashboard.example.com/embedded-yield/integrate/public-token")
      )
    ).toBe(false);
    expect(
      isPublicRoute(new NextRequest("https://dashboard.example.com/earn/integrate/public-token"))
    ).toBe(false);
    expect(
      isPublicRoute(
        new NextRequest("https://dashboard.example.com/dashboard/markets/embedded-yield")
      )
    ).toBe(false);
  });
});

describe("rejectCrossSiteWrite", () => {
  function write(path: string, headers: Record<string, string> = {}, method = "POST") {
    return new NextRequest(`https://dashboard.example.com${path}`, { method, headers });
  }

  it("refuses a cross-origin write to a BFF money route", async () => {
    const response = rejectCrossSiteWrite(
      write("/api/dashboard/markets/earn/vault-withdrawals", {
        origin: "https://attacker.example",
      })
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: { message: "Cross-origin request refused" },
    });
  });

  it("refuses a write from the sandboxed null origin", () => {
    const response = rejectCrossSiteWrite(
      write("/api/dashboard/payments/transfers", { origin: "null" })
    );
    expect(response?.status).toBe(403);
  });

  it("allows a same-origin write", () => {
    expect(
      rejectCrossSiteWrite(
        write("/api/dashboard/markets/earn/vault-withdrawals", {
          origin: "https://dashboard.example.com",
        })
      )
    ).toBeNull();
  });

  it("allows an origin-less write unless Sec-Fetch-Site marks it cross-site", () => {
    expect(rejectCrossSiteWrite(write("/api/dashboard/payments/transfers"))).toBeNull();
    expect(
      rejectCrossSiteWrite(
        write("/api/dashboard/payments/transfers", { "sec-fetch-site": "same-origin" })
      )
    ).toBeNull();
    expect(
      rejectCrossSiteWrite(
        write("/api/dashboard/payments/transfers", { "sec-fetch-site": "cross-site" })
      )?.status
    ).toBe(403);
  });

  it("leaves reads to the same-origin policy", () => {
    expect(
      rejectCrossSiteWrite(
        write(
          "/api/dashboard/markets/earn/movements",
          { origin: "https://attacker.example" },
          "GET"
        )
      )
    ).toBeNull();
  });

  it("gates playground writes but not routes outside the BFF", () => {
    expect(
      rejectCrossSiteWrite(write("/api/playground/execute", { origin: "https://attacker.example" }))
        ?.status
    ).toBe(403);
    expect(
      rejectCrossSiteWrite(
        write("/api/vendor/moneygram/sdk/v1", { origin: "https://attacker.example" })
      )
    ).toBeNull();
  });
});
