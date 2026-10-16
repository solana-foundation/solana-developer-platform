import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { fetchDataApiMetrics } from "./client";

const BASE_ENV: Env = { ENVIRONMENT: "development", API_VERSION: "test" };
const env: Env = { ...BASE_ENV, DATA_API_KEY: "data_test_key" };

function metricsResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ source: "memory_cache", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PAYLOAD = {
  generatedAt: "2026-10-13T13:45:57Z",
  truncated: false,
  rows: [
    {
      date: "2026-10-12",
      metric_name: "Transfer Count",
      unit: "Count",
      provider_name: "Allium",
      value: "14281000.0",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchDataApiMetrics", () => {
  it("reads the data team's preferred values with the deployment's key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => metricsResponse(PAYLOAD));

    const table = await fetchDataApiMetrics(env);

    expect(table.values.get("Transfer Count")?.get("2026-10-12")).toBe(14281000);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://data.solana.com/v1/metrics?provider=preferred");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("data_test_key");
  });

  it("is not configured without a key, and asks nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchDataApiMetrics(BASE_ENV)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503, not 500, when the API never answers", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await expect(fetchDataApiMetrics(env)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it.each([
    ["a failed answer", metricsResponse(PAYLOAD, 502)],
    ["an unexpected shape", metricsResponse({ rows: "none" })],
    [
      "an answer that does not say when it was built",
      metricsResponse({ ...PAYLOAD, generatedAt: "today" }),
    ],
    ["a truncated year", metricsResponse({ ...PAYLOAD, truncated: true })],
  ])("treats %s as the provider being unavailable", async (_case, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(fetchDataApiMetrics(env)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
