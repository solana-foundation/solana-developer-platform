import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardFetch } from "./dashboard-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboardFetch", () => {
  it("merges explicitly supplied headers with the JSON content type", async () => {
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
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: { enabled: true },
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Content-Type")).toBe("application/merge-patch+json");
  });
});
