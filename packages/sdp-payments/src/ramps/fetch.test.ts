import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError } from "../errors";
import { extractProviderErrorMessage, PROVIDER_MAX_RESPONSE_BYTES, providerFetch } from "./fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("extractProviderErrorMessage", () => {
  it("scrubs the counterparty fields providers echo back", () => {
    // Ramp providers validate what we submit and repeat it in the failure. That
    // message is both logged and returned, so it is the one place every
    // provider's error passes through.
    const message = extractProviderErrorMessage(
      { message: "email jane.doe@example.com is already registered" },
      "fallback"
    );

    assert.equal(message, "email [REDACTED_EMAIL] is already registered");
  });

  it("keeps the part of the message a developer acts on", () => {
    const message = extractProviderErrorMessage(
      { error: { message: "phone must be in E.164 format" } },
      "fallback"
    );

    assert.equal(message, "phone must be in E.164 format");
  });

  it("scrubs a credential that leaked into the provider payload", () => {
    const message = extractProviderErrorMessage(
      { errorMessage: 'unauthorized: {"apiKey":"ramp-secret"}' },
      "fallback"
    );

    assert.ok(!message.includes("ramp-secret"));
    assert.ok(message.startsWith("unauthorized"));
  });

  it("falls back when the payload carries no message", () => {
    assert.equal(extractProviderErrorMessage({ status: 500 }, "fallback"), "fallback");
    assert.equal(extractProviderErrorMessage(null, "fallback"), "fallback");
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

describe("providerFetch fences", () => {
  it("providerFetch_applies_a_default_timeout_without_a_caller_signal", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response("{}", { status: 200 });
    };

    await providerFetch("mural", "https://api.example.test/ping", { method: "GET" });

    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
  });

  it("providerFetch_refuses_a_body_over_the_byte_cap", async () => {
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
      providerFetch("mural", "https://api.example.test/huge", { method: "GET" }),
      (error: unknown) =>
        error instanceof SdpPaymentsError &&
        error.code === "PROVIDER_UNAVAILABLE" &&
        error.message.includes(String(PROVIDER_MAX_RESPONSE_BYTES))
    );
    assert.ok(pulled <= PROVIDER_MAX_RESPONSE_BYTES / chunk.byteLength + 2);
  });
});
