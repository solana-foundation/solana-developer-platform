import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { rootLogger } from "@/runtime/logger";
import { fetchProviderJson } from "./provider-json";

const schema = z.object({ figure: z.number() });
const REQUEST = { method: "GET", headers: {}, timeoutMs: 1_000, maxBytes: 64 } as const;

function answer(body: string, status = 200) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
}

const read = () => fetchProviderJson("test-provider", "https://provider.test/v1", schema, REQUEST);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchProviderJson", () => {
  it("parses the answer with the caller's schema", async () => {
    answer(JSON.stringify({ figure: 7 }));
    await expect(read()).resolves.toEqual({ figure: 7 });
  });

  it("refuses a body past its cap rather than reading it into memory", async () => {
    answer(JSON.stringify({ figure: 7, padding: "x".repeat(100) }));
    await expect(read()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "test-provider answered with more than 64 bytes",
      details: { provider: "test-provider", providerStatus: 200 },
    });
  });

  it("logs the provider's own wording, scrubbed, and answers with the status alone", async () => {
    answer(JSON.stringify({ message: "key for jane.doe@example.com is not valid" }), 401);
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

    await expect(read()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "test-provider answered 401",
      details: { provider: "test-provider", providerStatus: 401 },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_provider_error",
        provider: "test-provider",
        error_diagnostics: { providerMessage: "key for [REDACTED_EMAIL] is not valid" },
      }),
      "sdp_api_provider_error"
    );
  });

  it("logs where an answer missed its shape, never its values", async () => {
    answer(JSON.stringify({ figure: "seven" }));
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

    await expect(read()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_provider_response_invalid",
        issues: [{ path: "figure", code: "invalid_type" }],
      }),
      "sdp_api_provider_response_invalid"
    );
  });

  it.each([
    [
      "does not answer",
      () => vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("down")),
    ],
    ["answers with a body that is not JSON", () => answer("<html>")],
  ])("answers 503 when the provider %s", async (_case, arrange) => {
    arrange();
    await expect(read()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
