import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicRoute } from "./proxy";

describe("public web routes", () => {
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
});
