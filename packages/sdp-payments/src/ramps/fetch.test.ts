import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractProviderErrorMessage } from "./fetch";

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
