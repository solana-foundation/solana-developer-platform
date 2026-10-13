import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { rootLogger } from "@/runtime/logger";
import { autocompletePlaces } from "./google";

const ENV = { GOOGLE_ADDRESS_COMPLETION_API_KEY: "test-places-key" };
const REQUEST = { input: "1 Main St", sessionToken: "session-1" };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Google Maps request failures", () => {
  it("answers with the status alone and logs Google's scrubbed wording", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: "API key for jane.doe@example.com is not valid" } }),
        { status: 400 }
      );
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);

    const failure = await autocompletePlaces(ENV, REQUEST).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "Google Maps request failed with status 400",
      details: { provider: "google", providerStatus: 400 },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_places_provider_error",
        provider_status: 400,
        error_diagnostics: { providerMessage: "API key for [REDACTED_EMAIL] is not valid" },
      }),
      "sdp_api_places_provider_error"
    );
  });
});
