import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { SdpPaymentsError } from "../errors";
import {
  isDefinitiveProviderRejection,
  providerErrorMessageSchema,
  providerFetch,
  providerFetchJson,
} from "./fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isDefinitiveProviderRejection", () => {
  for (const [name, error, expected] of [
    [
      "400",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 400 }),
      true,
    ],
    [
      "409",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 409 }),
      false,
    ],
    [
      "408",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 408 }),
      false,
    ],
    [
      "499",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 499 }),
      true,
    ],
    [
      "500",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe", providerStatus: 500 }),
      false,
    ],
    [
      "details without providerStatus",
      new SdpPaymentsError("BAD_REQUEST", "x", { provider: "stripe" }),
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

    assert.equal(capturedSignal, controller.signal);
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
    assert.deepEqual(error.details, { provider: "moonpay", providerStatus: 400 });
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
        assert.equal(cause.code, "PROVIDER_UNAVAILABLE");
        assert.equal(cause.message, "moonpay returned an unexpected response");
        assert.deepEqual(cause.details, { provider: "moonpay" });
        assert.deepEqual(cause.diagnostics, {
          issues: [{ path: "quoteCurrencyAmount", code: "invalid_type" }],
        });
        assert.ok(!JSON.stringify(cause.diagnostics).includes("jane.doe"));
        return true;
      }
    );
  });
});
