import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { rootLogger } from "@/runtime/logger";
import { autocompletePlaces, fetchStaticMap } from "./google";

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
      message: "google answered 400",
      details: { provider: "google", providerStatus: 400 },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_provider_error",
        provider: "google",
        provider_status: 400,
        error_diagnostics: { providerMessage: "API key for [REDACTED_EMAIL] is not valid" },
      }),
      "sdp_api_provider_error"
    );
  });
});

describe("fetchStaticMap limits", () => {
  const MAP_REQUEST = { latitude: 1.23, longitude: 4.56, width: 288, height: 560 };

  it("returns the map assembled from a body that arrives split across chunks", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(png.slice(0, 4));
            controller.enqueue(png.slice(4));
            controller.close();
          },
        }),
        { status: 200 }
      );

    const map = await fetchStaticMap(ENV, MAP_REQUEST);

    expect(map.status).toBe(200);
    expect(map.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await map.arrayBuffer())).toEqual(png);
  });

  it("cancels a body that exceeds the byte cap and fails the request", async () => {
    let canceled = false;
    const megabyte = new Uint8Array(1024 * 1024).fill(7);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(megabyte);
            controller.enqueue(megabyte);
            controller.enqueue(megabyte);
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200 }
      );

    const failure = await fetchStaticMap(ENV, MAP_REQUEST).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "Google Static Maps response could not be read",
    });
    // The oversized stream is torn down, not left running to fill memory.
    expect(canceled).toBe(true);
  });

  it("fails a stalled body when the deadline fires", async () => {
    // The 10s production deadline is too long to wait out in a test, so this
    // shortens the same call — proving the deadline reaches fetch and that a
    // body which never finishes rejects instead of hanging the request.
    const realDeadline = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realDeadline(25));
    globalThis.fetch = (_input, init) => {
      const signal = init?.signal ?? null;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () =>
                controller.error(new Error("deadline fired"))
              );
            },
          }),
          { status: 200 }
        )
      );
    };

    const failure = await fetchStaticMap(ENV, MAP_REQUEST).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "Google Static Maps response could not be read",
    });
  });
});
