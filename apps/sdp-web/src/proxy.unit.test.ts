import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicRoute } from "./proxy";

describe("public web routes", () => {
  it("keeps the workspace loading transition available during bootstrap", () => {
    expect(isPublicRoute(new NextRequest("https://dashboard.example.com/workspace-loading"))).toBe(
      true
    );
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
