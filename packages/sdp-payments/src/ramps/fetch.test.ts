import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "../errors";
import {
  classifyProviderFailure,
  isDefinitiveProviderRejection,
  PROVIDER_MAX_RESPONSE_BYTES,
  PROVIDER_REQUEST_TIMEOUT_MS,
  providerErrorMessageSchema,
  providerFetch,
  providerFetchJson,
} from "./fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("classifyProviderFailure", () => {
  for (const [status, code, outcome] of [
    [400, "BAD_REQUEST", "rejected"],
    [401, "PROVIDER_NOT_CONFIGURED", "rejected"],
    [403, "PROVIDER_NOT_CONFIGURED", "rejected"],
    [404, "BAD_REQUEST", "rejected"],
    [408, "PROVIDER_UNAVAILABLE", "unknown"],
    [409, "CONFLICT", "unknown"],
    [422, "BAD_REQUEST", "rejected"],
    [429, "RATE_LIMITED", "rejected"],
    [499, "BAD_REQUEST", "rejected"],
    [500, "PROVIDER_UNAVAILABLE", "unknown"],
    [503, "PROVIDER_UNAVAILABLE", "unknown"],
    [304, "PROVIDER_UNAVAILABLE", "unknown"],
  ] as const) {
    it(`classifies ${status} as ${code}, ${outcome}`, () => {
      assert.deepEqual(classifyProviderFailure(status), { code, outcome });
    });
  }
});

describe("isDefinitiveProviderRejection", () => {
  for (const [name, error, expected] of [
    [
      "a rejected outcome",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", outcome: "rejected" }),
      true,
    ],
    [
      "an unknown outcome",
      new SdpPaymentsError("PROVIDER_UNAVAILABLE", "x", { provider: "stripe", outcome: "unknown" }),
      false,
    ],
    [
      "a 4xx status with no outcome",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 400 }),
      false,
    ],
    ["no details", new SdpPaymentsError("BAD_REQUEST", "x"), false],
    ["plain Error", new Error("x"), false],
  ] as const) {
    it(`returns ${expected} for ${name}`, () => {
      assert.equal(isDefinitiveProviderRejection(error), expected);
    });
  }
});

describe("providerErrorMessageSchema", () => {
  it("scrubs the counterparty fields providers echo back", () => {
    // Ramp providers validate what we submit and repeat it in the failure, and
    // every provider's error message passes through this one parse.
    const message = providerErrorMessageSchema.parse({
      message: "email jane.doe@example.com is already registered",
    });

    assert.equal(message, "email [REDACTED_EMAIL] is already registered");
  });

  it("keeps the part of the message a developer acts on", () => {
    const message = providerErrorMessageSchema.parse({
      error: { message: "phone must be in E.164 format" },
    });

    assert.equal(message, "phone must be in E.164 format");
  });

  it("scrubs a credential that leaked into the provider payload", () => {
    const message = providerErrorMessageSchema.parse({
      errorMessage: 'unauthorized: {"apiKey":"ramp-secret"}',
    });

    assert.ok(message !== undefined && !message.includes("ramp-secret"));
    assert.ok(message.startsWith("unauthorized"));
  });

  it("reads past a field that is not text", () => {
    assert.equal(
      providerErrorMessageSchema.parse({ error: { message: 42 }, message: "flat" }),
      "flat"
    );
    assert.equal(providerErrorMessageSchema.parse({ message: "   ", reason: "why" }), "why");
  });

  it("parses a body with no message to undefined", () => {
    for (const body of [{ status: 500 }, { error: "invalid_grant" }, null, "oops", [1]]) {
      assert.equal(providerErrorMessageSchema.parse(body), undefined, JSON.stringify(body));
    }
  });
});

describe("providerFetch abort signal", () => {
  it("providerFetch_forwards_abort_signal", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await providerFetch("bvnk", "https://api.example.test/ping", {
      method: "GET",
      signal: controller.signal,
    });

    // The caller's signal joins the timeout: aborting it aborts the request.
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
    controller.abort();
    assert.equal(capturedSignal.aborted, true);
    assert.deepEqual(result.parsed, { ok: true });
    assert.equal(result.raw, '{"ok":true}');
  });
});

describe("providerFetchJson failures", () => {
  function respondWith(status: number, body: string): void {
    globalThis.fetch = async () => new Response(body, { status });
  }

  async function failure(): Promise<SdpPaymentsError> {
    try {
      await providerFetchJson(
        "moonpay",
        "https://api.example.test/quote",
        { method: "GET" },
        z.object({ quoteCurrencyAmount: z.number() })
      );
    } catch (error) {
      assert.ok(error instanceof SdpPaymentsError);
      return error;
    }
    assert.fail("the provider call must fail");
  }

  it("keeps the provider's wording out of the public error and in diagnostics", async () => {
    respondWith(
      400,
      JSON.stringify({ message: "email jane.doe@example.com is already registered" })
    );

    const error = await failure();

    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.message, "moonpay request failed with status 400");
    assert.deepEqual(error.details, {
      provider: "moonpay",
      providerStatus: 400,
      outcome: "rejected",
    });
    assert.deepEqual(error.diagnostics, {
      providerMessage: "email [REDACTED_EMAIL] is already registered",
    });
  });

  it("carries no diagnostics when the provider body names no message", async () => {
    respondWith(503, "<html>upstream unavailable</html>");

    const error = await failure();

    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.message, "moonpay request failed with status 503");
    assert.equal(error.diagnostics, undefined);
  });

  it("answers a credential refusal as our misconfiguration, not the caller's request", async () => {
    respondWith(401, JSON.stringify({ message: "Invalid API key" }));

    const error = await failure();

    assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
    assert.equal(error.details?.outcome, "rejected");
  });

  it("calls a success it cannot parse invalid, with an unknown outcome", async () => {
    respondWith(200, "<html>ok</html>");

    const error = await failure();

    assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, "moonpay returned an unparseable response");
    assert.deepEqual(error.details, { provider: "moonpay", outcome: "unknown" });
  });

  it("keeps the transport failure's structure, never its message", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed https://api.example.test/quote?apiKey=pk_test_secret", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    };

    const error = await failure();

    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.message, "Failed to reach the moonpay API");
    assert.deepEqual(error.details, { provider: "moonpay", outcome: "unknown" });
    assert.deepEqual(error.diagnostics, {
      transportError: "TypeError",
      transportCode: "ECONNRESET",
    });
    assert.ok(!JSON.stringify(error.diagnostics).includes("apiKey"));
  });
});

describe("providerFetch request headers", () => {
  async function sentHeaders(
    body: Record<string, string> | URLSearchParams | undefined,
    headers?: HeadersInit
  ): Promise<Headers> {
    let sent: Headers | undefined;
    globalThis.fetch = async (input, init) => {
      sent = new Request(input, init).headers;
      return new Response("{}", { status: 200 });
    };
    await providerFetch("stripe", "https://api.example.test/x", {
      method: body === undefined ? "GET" : "POST",
      body,
      headers,
    });
    assert.ok(sent !== undefined, "the request was sent");
    return sent;
  }

  it("sends no Content-Type without a body", async () => {
    const headers = await sentHeaders(undefined);
    assert.equal(headers.get("content-type"), null);
    assert.equal(headers.get("accept"), "application/json");
  });

  it("types a JSON body as JSON", async () => {
    const headers = await sentHeaders({ amount: "10" });
    assert.equal(headers.get("content-type"), "application/json");
  });

  it("lets a form body carry the form type", async () => {
    const headers = await sentHeaders(new URLSearchParams({ amount: "10" }));
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded;charset=UTF-8");
  });

  it("lets the caller's headers win", async () => {
    const headers = await sentHeaders(
      { amount: "10" },
      { "Content-Type": "application/vnd.x+json" }
    );
    assert.equal(headers.get("content-type"), "application/vnd.x+json");
  });
});

describe("providerFetchJson response schema", () => {
  const quoteSchema = z.object({ quoteCurrencyAmount: z.number() });

  function respondOk(body: Record<string, unknown>): void {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  }

  it("returns the fields the schema names", async () => {
    respondOk({ quoteCurrencyAmount: 0.3, internalField: "dropped" });

    const quote = await providerFetchJson(
      "moonpay",
      "https://api.example.test/quote",
      { method: "GET" },
      quoteSchema
    );

    assert.deepEqual(quote, { quoteCurrencyAmount: 0.3 });
  });

  it("fails closed on a response that does not match, naming only the field", async () => {
    respondOk({ quoteCurrencyAmount: "0.3 for jane.doe@example.com" });

    await assert.rejects(
      providerFetchJson(
        "moonpay",
        "https://api.example.test/quote",
        { method: "GET" },
        quoteSchema
      ),
      (cause: unknown) => {
        assert.ok(cause instanceof SdpPaymentsError);
        assert.equal(cause.code, "PROVIDER_RESPONSE_INVALID");
        assert.equal(cause.message, "moonpay returned an unexpected response");
        assert.deepEqual(cause.details, { provider: "moonpay", outcome: "unknown" });
        assert.deepEqual(cause.diagnostics, {
          issues: [{ path: "quoteCurrencyAmount", code: "invalid_type" }],
        });
        assert.ok(!JSON.stringify(cause.diagnostics).includes("jane.doe"));
        return true;
      }
    );
  });
});

describe("providerFetch fences", () => {
  /** A provider that accepts the request and never answers, as real fetch does on abort. */
  function hangUntilAborted(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }

  function failsWith(message: string, code: SdpPaymentsErrorCode) {
    return (cause: unknown) => {
      assert.ok(cause instanceof SdpPaymentsError);
      assert.equal(cause.code, code);
      assert.equal(cause.message, message);
      return true;
    };
  }

  // A dropped timeout hangs these; the test timeout turns that into a failure.
  it("gives up on a provider that never answers once the timeout passes", {
    timeout: 5_000,
  }, async (t) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      requested.push(ms);
      return timeout(10);
    });
    globalThis.fetch = hangUntilAborted;

    await assert.rejects(
      providerFetch("stripe", "https://api.example.test/hang", { method: "GET" }),
      failsWith(
        `The stripe API did not answer within ${PROVIDER_REQUEST_TIMEOUT_MS} ms`,
        "PROVIDER_UNAVAILABLE"
      )
    );
    assert.deepEqual(requested, [PROVIDER_REQUEST_TIMEOUT_MS]);
  });

  it("still honors the caller's own signal", async () => {
    const caller = new AbortController();
    globalThis.fetch = hangUntilAborted;

    const pending = providerFetch("moonpay", "https://api.example.test/hang", {
      method: "GET",
      signal: caller.signal,
    });
    caller.abort();

    await assert.rejects(
      pending,
      failsWith("Failed to reach the moonpay API", "PROVIDER_UNAVAILABLE")
    );
  });

  it("gives up on a body that stops arriving once the timeout passes", {
    timeout: 5_000,
  }, async (t) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", () => timeout(10));
    globalThis.fetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 }
      );

    await assert.rejects(
      providerFetch("stripe", "https://api.example.test/slow", { method: "GET" }),
      failsWith(
        `The stripe API response did not finish within ${PROVIDER_REQUEST_TIMEOUT_MS} ms`,
        "PROVIDER_RESPONSE_INVALID"
      )
    );
  });

  it("refuses a body over the byte cap without reading the rest", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 }
      );

    await assert.rejects(
      providerFetch("moonpay", "https://api.example.test/huge", { method: "GET" }),
      failsWith(
        `moonpay returned a response over ${PROVIDER_MAX_RESPONSE_BYTES} bytes`,
        "PROVIDER_RESPONSE_INVALID"
      )
    );
    assert.ok(pulled <= PROVIDER_MAX_RESPONSE_BYTES / chunk.byteLength + 2);
  });

  it("keeps a refusal's meaning when its body is unreadable", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { status: 400 }
      );

    await assert.rejects(
      providerFetch("moonpay", "https://api.example.test/huge", { method: "GET" }),
      (cause: unknown) => {
        assert.ok(cause instanceof SdpPaymentsError);
        assert.equal(cause.code, "BAD_REQUEST");
        assert.equal(cause.details?.outcome, "rejected");
        return true;
      }
    );
  });
});
