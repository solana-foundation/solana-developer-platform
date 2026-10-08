import { NextFetchEvent, NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ protect: vi.fn(async () => undefined) }));

vi.mock("@clerk/nextjs/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/nextjs/server")>();
  return {
    ...actual,
    clerkMiddleware:
      (
        handler: (
          auth: { protect: typeof clerk.protect },
          request: NextRequest,
          event: NextFetchEvent
        ) => unknown
      ) =>
      (request: NextRequest, event: NextFetchEvent) =>
        handler({ protect: clerk.protect }, request, event),
  };
});

import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { isPublicRoute, proxy, rejectCrossSiteWrite } from "./proxy";

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

describe("proxy request project", () => {
  async function runProxy(request: NextRequest): Promise<Response> {
    const result = await proxy(
      request,
      new NextFetchEvent({ request, page: "/", context: undefined })
    );
    if (!(result instanceof Response)) {
      throw new Error(`proxy returned no response for ${request.nextUrl.pathname}`);
    }
    return result;
  }

  function dashboardRequest(
    path: string,
    init: { method: string; headers: Record<string, string> }
  ) {
    return new NextRequest(`https://dashboard.example.com${path}`, init);
  }

  function forwardedProjectId(response: Response): string | null {
    return response.headers.get("x-middleware-request-x-project-id");
  }

  function overriddenRequestHeaderNames(response: Response): string[] {
    const names = response.headers.get("x-middleware-override-headers");
    if (names === null) {
      throw new Error("proxy forwarded no request headers");
    }
    return names.split(",");
  }

  function lastUsedCookies(response: Response): string[] {
    return response.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith("sdp_selected_project_id="));
  }

  it("scopes a page render to the project in its URL over a browser-sent one", async () => {
    const response = await runProxy(
      dashboardRequest(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`, {
        method: "GET",
        headers: { "x-project-id": PRODUCTION_PROJECT.id },
      })
    );

    expect(response.headers.get("location")).toBeNull();
    expect(forwardedProjectId(response)).toBe(SANDBOX_PROJECT.id);
  });

  it("scopes a server action to the project of the tab that posted it", async () => {
    const response = await runProxy(
      dashboardRequest(`/dashboard/${PRODUCTION_PROJECT.id}`, {
        method: "POST",
        headers: { "next-action": "action_test" },
      })
    );

    expect(forwardedProjectId(response)).toBe(PRODUCTION_PROJECT.id);
  });

  it("drops a browser-sent project on a page outside any project", async () => {
    for (const path of ["/dashboard", "/dashboard//evil.com", "/settings"]) {
      const response = await runProxy(
        dashboardRequest(path, { method: "GET", headers: { "x-project-id": SANDBOX_PROJECT.id } })
      );

      expect(response.headers.get("location")).toBeNull();
      expect(forwardedProjectId(response)).toBeNull();
      expect(overriddenRequestHeaderNames(response)).not.toContain("x-project-id");
    }
  });

  it("keeps the project a browser call to the dashboard backend sent", async () => {
    const response = await runProxy(
      dashboardRequest("/api/dashboard/home/activity", {
        method: "GET",
        headers: { "x-project-id": SANDBOX_PROJECT.id },
      })
    );

    expect(response.headers.get("location")).toBeNull();
    expect(forwardedProjectId(response)).toBe(SANDBOX_PROJECT.id);
    expect(overriddenRequestHeaderNames(response)).toContain("x-project-id");
  });

  it("sends a project-less dashboard page to the landing with its path and query", async () => {
    const response = await runProxy(
      dashboardRequest("/dashboard/payments/transactions?tab=x", { method: "GET", headers: {} })
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://dashboard.example.com/dashboard?return_to=${encodeURIComponent("/dashboard/payments/transactions?tab=x")}`
    );
    expect(lastUsedCookies(response)).toEqual([]);
  });

  it("records a project-scoped page as the last-used project", async () => {
    const response = await runProxy(
      dashboardRequest(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`, {
        method: "GET",
        headers: { cookie: `sdp_selected_project_id=${PRODUCTION_PROJECT.id}` },
      })
    );

    expect(lastUsedCookies(response)).toHaveLength(1);
    expect(lastUsedCookies(response)[0]).toMatch(
      new RegExp(`^sdp_selected_project_id=${SANDBOX_PROJECT.id};`)
    );
  });

  it("records nothing outside a project-scoped page", async () => {
    for (const path of ["/dashboard", "/api/dashboard/home/activity"]) {
      const response = await runProxy(
        dashboardRequest(path, { method: "GET", headers: { "x-project-id": SANDBOX_PROJECT.id } })
      );

      expect(lastUsedCookies(response)).toEqual([]);
    }
  });
});
