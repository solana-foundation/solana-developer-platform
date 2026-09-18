import { describe, expect, it } from "vitest";
import { rethrowVaultProviderFailure } from "./vault-refusals";

class TestProviderError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

describe("rethrowVaultProviderFailure", () => {
  it.each([
    "INVALID_AMOUNT",
    "DEPOSIT_REFUSED",
    "WITHDRAW_REFUSED",
    "COMPLIANCE_APPROVAL_REQUIRED",
    "INVALID_QUEUE_PARAMETERS",
  ])("maps provider refusal %s to a caller 400", (code) => {
    expect(() =>
      rethrowVaultProviderFailure(new TestProviderError(code, "provider refused the request"))
    ).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "provider refused the request",
      })
    );
  });

  it("maps a queue request that closed during cancellation build to a 409", () => {
    expect(() =>
      rethrowVaultProviderFailure(
        new TestProviderError(
          "WITHDRAWAL_REQUEST_NOT_FOUND",
          "The queued withdrawal no longer exists or is already closed"
        )
      )
    ).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        statusCode: 409,
        message: "The queued withdrawal no longer exists or is already closed",
      })
    );
  });

  it("maps unreadable provider state to a sanitized retryable 503", () => {
    expect(() =>
      rethrowVaultProviderFailure(
        new TestProviderError("VAULT_UNREADABLE", "RPC returned 429 from a secret endpoint")
      )
    ).toThrow(
      expect.objectContaining({
        code: "PROVIDER_UNAVAILABLE",
        statusCode: 503,
        message: "Earn provider is temporarily unavailable. Try again.",
      })
    );
  });

  it("preserves unknown failures for the global error boundary", () => {
    const cause = new TestProviderError("NEW_PROVIDER_FAILURE", "unexpected provider failure");
    expect(() => rethrowVaultProviderFailure(cause)).toThrow(cause);
  });
});
