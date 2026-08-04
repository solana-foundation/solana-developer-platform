import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { SdpEarnError, type SdpEarnErrorCode } from "./errors";
import {
  classifyProviderStatus,
  extractProviderErrorMessage,
  providerFetch,
  providerFetchJson,
} from "./fetch";

/**
 * Canonical no-network provider-client test pattern: stub `globalThis.fetch`
 * with `node:test` `mock.method` inside each test and `mock.restoreAll()` in
 * `afterEach`. Tests for anything built on providerFetch must copy this
 * harness — no test may ever reach a real provider API.
 */
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const earnError =
  (code: SdpEarnErrorCode, message?: RegExp) =>
  (error: unknown): boolean =>
    error instanceof SdpEarnError &&
    error.code === code &&
    (message === undefined || message.test(error.message));

describe("classifyProviderStatus", () => {
  it("maps provider statuses onto the SdpEarnError taxonomy", () => {
    assert.equal(classifyProviderStatus(409), "CONFLICT");
    assert.equal(classifyProviderStatus(429), "RATE_LIMITED");
    assert.equal(classifyProviderStatus(500), "PROVIDER_UNAVAILABLE");
    assert.equal(classifyProviderStatus(503), "PROVIDER_UNAVAILABLE");
  });

  it("treats every other 4xx as a caller error", () => {
    assert.equal(classifyProviderStatus(400), "BAD_REQUEST");
    assert.equal(classifyProviderStatus(404), "BAD_REQUEST");
    assert.equal(classifyProviderStatus(422), "BAD_REQUEST");
  });
});

describe("extractProviderErrorMessage", () => {
  it("prefers error.message, then message, then reason", () => {
    assert.equal(
      extractProviderErrorMessage({ error: { message: "nested" }, message: "flat" }, "fallback"),
      "nested"
    );
    assert.equal(
      extractProviderErrorMessage({ message: "flat", reason: "why" }, "fallback"),
      "flat"
    );
    assert.equal(extractProviderErrorMessage({ reason: "why" }, "fallback"), "why");
  });

  it("falls back for non-object payloads", () => {
    assert.equal(extractProviderErrorMessage(undefined, "fallback"), "fallback");
    assert.equal(extractProviderErrorMessage(null, "fallback"), "fallback");
    assert.equal(extractProviderErrorMessage("oops", "fallback"), "fallback");
  });

  it("falls back for non-string or blank message fields", () => {
    assert.equal(extractProviderErrorMessage({}, "fallback"), "fallback");
    assert.equal(extractProviderErrorMessage({ message: 42 }, "fallback"), "fallback");
    assert.equal(extractProviderErrorMessage({ message: "   " }, "fallback"), "fallback");
  });
});

describe("providerFetch", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("sends JSON headers by default and serializes object bodies", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, { ok: true }));

    await providerFetch("veda", "https://veda.test/deposit", {
      method: "POST",
      body: { amount: "100" },
    });

    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, "https://veda.test/deposit");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    assert.equal(init?.body, JSON.stringify({ amount: "100" }));
  });

  it("passes URLSearchParams bodies through and lets caller headers win", async () => {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, {}));

    await providerFetch("veda", "https://veda.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const [, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(init?.body, form);
    assert.deepEqual(init?.headers, {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    });
  });

  it("passes string bodies through unserialized and omits absent bodies", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => jsonResponse(200, {}));

    await providerFetch("veda", "https://veda.test/raw", { method: "PUT", body: "raw-payload" });
    await providerFetch("veda", "https://veda.test/vaults", { method: "GET" });

    assert.equal(fetchMock.mock.calls[0].arguments[1]?.body, "raw-payload");
    assert.equal(fetchMock.mock.calls[1].arguments[1]?.body, undefined);
  });

  it("returns the raw body alongside parsed JSON", async () => {
    mock.method(globalThis, "fetch", async () => new Response('{"nav":"1.05"}', { status: 200 }));

    const result = await providerFetch("veda", "https://veda.test/nav", { method: "GET" });

    assert.equal(result.raw, '{"nav":"1.05"}');
    assert.deepEqual(result.parsed, { nav: "1.05" });
    assert.equal(result.response.status, 200);
  });

  it("returns parsed undefined for non-JSON bodies instead of throwing", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response("<html>oops</html>", { status: 200 })
    );

    const result = await providerFetch("veda", "https://veda.test/nav", { method: "GET" });

    assert.equal(result.raw, "<html>oops</html>");
    assert.equal(result.parsed, undefined);
  });

  it("wraps transport failures as PROVIDER_UNAVAILABLE naming the provider", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });

    await assert.rejects(
      providerFetch("upshift", "https://upshift.test/vaults", { method: "GET" }),
      earnError("PROVIDER_UNAVAILABLE", /upshift/)
    );
  });
});

describe("providerFetchJson", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("returns the parsed body on success", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(200, { shares: "42" }));

    const result = await providerFetchJson<{ shares: string }, { amount: string }>(
      "veda",
      "https://veda.test/deposit",
      { method: "POST", body: { amount: "100" } }
    );

    assert.deepEqual(result, { shares: "42" });
  });

  it("classifies failure statuses into the SdpEarnError taxonomy", async () => {
    let status = 500;
    mock.method(globalThis, "fetch", async () => jsonResponse(status, {}));

    const cases: Array<[number, SdpEarnErrorCode]> = [
      [400, "BAD_REQUEST"],
      [404, "BAD_REQUEST"],
      [409, "CONFLICT"],
      [429, "RATE_LIMITED"],
      [500, "PROVIDER_UNAVAILABLE"],
      [503, "PROVIDER_UNAVAILABLE"],
    ];
    for (const [providerStatus, code] of cases) {
      status = providerStatus;
      await assert.rejects(
        providerFetchJson("veda", "https://veda.test/deposit", { method: "POST" }),
        (error: unknown) =>
          error instanceof SdpEarnError &&
          error.code === code &&
          error.details?.provider === "veda" &&
          error.details?.providerStatus === providerStatus
      );
    }
  });

  it("surfaces the provider's error message when the failure body carries one", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse(409, { error: { message: "Position already exists" } })
    );

    await assert.rejects(
      providerFetchJson("veda", "https://veda.test/deposit", { method: "POST" }),
      earnError("CONFLICT", /^Position already exists$/)
    );
  });

  it("falls back to a status message when the failure body is not JSON", async () => {
    mock.method(globalThis, "fetch", async () => new Response("Bad Gateway", { status: 502 }));

    await assert.rejects(
      providerFetchJson("perena", "https://perena.test/nav", { method: "GET" }),
      earnError("PROVIDER_UNAVAILABLE", /^perena request failed with status 502$/)
    );
  });

  it("treats an OK response with an unparseable body as PROVIDER_UNAVAILABLE", async () => {
    mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));

    await assert.rejects(
      providerFetchJson("ground", "https://ground.test/vaults", { method: "GET" }),
      earnError("PROVIDER_UNAVAILABLE", /unparseable/)
    );
  });
});
