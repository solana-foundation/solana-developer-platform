import { afterEach, assert, describe, expect, it, vi } from "vitest";
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

  it("returns 503 when the deadline fires before response headers arrive", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      assert.instanceOf(signal, AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const request = fetchStaticMap(ENV, MAP_REQUEST);
    deadline.abort(new DOMException("deadline fired", "TimeoutError"));

    await expect(request).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Google Static Maps did not answer",
      details: { provider: "google", reason: "TimeoutError" },
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("returns 503 for a network failure without exposing the credential-bearing URL", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(
        `failed to fetch https://maps.googleapis.com/?key=${ENV.GOOGLE_ADDRESS_COMPLETION_API_KEY}`
      )
    );

    await expect(fetchStaticMap(ENV, MAP_REQUEST)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Google Static Maps did not answer",
      details: { provider: "google", reason: "TypeError" },
    });
  });

  it("returns 503 when the provider sends no map body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await expect(fetchStaticMap(ENV, MAP_REQUEST)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Google Static Maps response could not be read",
    });
  });

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
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    globalThis.fetch = (_input, init) => {
      const signal = init?.signal;
      assert.instanceOf(signal, AbortSignal);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { status: 200 }
        )
      );
    };

    const request = fetchStaticMap(ENV, MAP_REQUEST);
    deadline.abort(new DOMException("deadline fired", "TimeoutError"));

    await expect(request).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Google Static Maps response could not be read",
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });
});
