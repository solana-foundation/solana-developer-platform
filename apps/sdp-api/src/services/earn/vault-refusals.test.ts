import type { VaultProviderErrorCode } from "@sdp/earn/types";
import {
  RpcHttpStatusError,
  RpcTimeoutError,
  RpcUnavailableError,
  SdpRpcError,
} from "@sdp/rpc/errors";
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

/**
 * Every shared vault provider code and the answer the API gives it. A change
 * to this table is a public status change; review it as one.
 */
const STATUS_BY_CODE = {
  INVALID_AMOUNT: 400,
  DEPOSIT_REFUSED: 400,
  WITHDRAW_REFUSED: 400,
  REDEMPTION_REFUSED: 400,
  COMPLIANCE_APPROVAL_REQUIRED: 400,
  INVALID_QUEUE_PARAMETERS: 400,
  WITHDRAWAL_REQUEST_NOT_FOUND: 409,
  VAULT_UNREADABLE: 503,
  REQUEST_UNREADABLE: 503,
  POSITION_UNREADABLE: 503,
  SWAP_UNAVAILABLE: 503,
  DEPLOYMENT_NOT_CONFIGURED: "rethrown",
  CLUSTER_UNSUPPORTED: "rethrown",
  UNSUPPORTED_VAULT: "rethrown",
  INCOMPATIBLE_DEPLOYMENT: "rethrown",
  PROGRAM_MISMATCH: "rethrown",
  MINT_MISMATCH: "rethrown",
} as const satisfies Record<VaultProviderErrorCode, 400 | 409 | 503 | "rethrown">;

describe("rethrowVaultProviderFailure", () => {
  it.each(Object.entries(STATUS_BY_CODE))("answers %s with %s", (code, status) => {
    const error = new TestProviderError(code, "provider failure");
    if (status === "rethrown") {
      expect(() => rethrowVaultProviderFailure(error)).toThrow(error);
    } else {
      expect(() => rethrowVaultProviderFailure(error)).toThrow(
        expect.objectContaining({ statusCode: status })
      );
    }
  });

  it("carries a provider refusal's own sentence to the caller", () => {
    expect(() =>
      rethrowVaultProviderFailure(
        new TestProviderError("DEPOSIT_REFUSED", "provider refused the request")
      )
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

  it.each([
    new RpcUnavailableError("not_configured", "Private endpoint is unavailable", {
      cluster: "devnet",
    }),
    new RpcTimeoutError(100),
    new RpcHttpStatusError(503, "Private RPC endpoint returned 503"),
  ])("maps a raw $name to a sanitized retryable 503", (error) => {
    expect(() => rethrowVaultProviderFailure(error)).toThrow(
      expect.objectContaining({
        code: "PROVIDER_UNAVAILABLE",
        statusCode: 503,
        message: "Earn provider is temporarily unavailable. Try again.",
      })
    );
  });

  it("preserves missing cluster scope as an internal fault", () => {
    const error = new SdpRpcError("CLUSTER_SCOPE_MISSING", "Cluster scope is missing");
    expect(() => rethrowVaultProviderFailure(error)).toThrow(error);
  });
});
