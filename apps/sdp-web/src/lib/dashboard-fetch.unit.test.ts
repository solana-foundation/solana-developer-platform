import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { dashboardFetch, dashboardRequest } from "./dashboard-fetch";

function noContentFetchMock() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
  );
}

function sentHeaders(fetchMock: ReturnType<typeof noContentFetchMock>): Headers {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

afterEach(() => {
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("dashboardFetch", () => {
  it("merges explicitly supplied headers with the JSON content type", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/markets/earn`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/test", {
      method: "POST",
      headers: { "Idempotency-Key": "deposit-key" },
      body: { amount: "1" },
    });

    const options = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(options?.headers);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(options?.body).toBe(JSON.stringify({ amount: "1" }));
  });

  it("does not overwrite an explicitly selected content type", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/custody`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: { enabled: true },
    });

    expect(sentHeaders(fetchMock).get("Content-Type")).toBe("application/merge-patch+json");
  });

  it("sends the project in the tab's URL", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/transfers`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/dashboard/payments/transfers", {});

    expect(sentHeaders(fetchMock).get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });
});

describe("dashboardRequest", () => {
  it("sends the project in the tab's URL over a caller-supplied project header", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest("/api/dashboard/home/activity", {
      headers: { "x-project-id": "prj_test_production" },
    });

    expect(sentHeaders(fetchMock).get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });

  it("sends no project header outside a project-scoped URL", async () => {
    setWindowPathname("/dashboard/payments");
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest("/api/dashboard/payments/transfers", {});

    expect(sentHeaders(fetchMock).has("x-project-id")).toBe(false);
  });
});
