// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { getDashboard } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("reads the dashboard from its origin", async () => {
  const fetchMock = vi.fn(async (_url: URL | RequestInfo) =>
    Response.json({ data: { operations: [] } })
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(getDashboard()).resolves.toEqual({ operations: [] });
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    `${window.location.origin}/api/dashboard`
  );
});

it("retains the API retry delay for polling backoff", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { message: "Slow down" } },
        { status: 429, headers: { "Retry-After": "12" } }
      )
    )
  );
  await expect(getDashboard()).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 12_000,
    message: "Slow down",
  });
});
