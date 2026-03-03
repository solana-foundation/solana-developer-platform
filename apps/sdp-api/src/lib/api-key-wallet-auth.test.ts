import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { describe, expect, it } from "vitest";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIds,
  resolveApiKeySigningWalletId,
} from "./api-key-wallet-auth";

function createApiKeyAuth(overrides: Partial<ApiKeyContext> = {}): ApiKeyContext {
  return {
    id: "key_test",
    organizationId: "org_test",
    projectId: null,
    role: "api_developer",
    permissions: ["*"],
    environment: "sandbox",
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    authType: "api_key",
    userId: null,
    apiKeyId: "key_test",
    ...overrides,
  };
}

describe("api-key wallet auth helpers", () => {
  it("allows unbound keys to access wallets (legacy behavior)", () => {
    const auth = createApiKeyAuth();
    expect(() => assertApiKeyWalletAccess(auth, "any_wallet", ["payments:write"])).not.toThrow();
  });

  it("rejects wallets that are not bound to the API key", () => {
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_a", permissions: ["*"] }],
    });

    expect(() => assertApiKeyWalletAccess(auth, "wal_b")).toThrowError(AppError);
  });

  it("enforces wallet-level permission checks", () => {
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_a", permissions: ["tokens:write"] }],
    });

    expect(() => assertApiKeyWalletAccess(auth, "wal_a", ["tokens:write"])).not.toThrow();
    expect(() => assertApiKeyWalletAccess(auth, "wal_a", ["payments:write"])).toThrowError(
      AppError
    );
  });

  it("resolves the requested wallet when authorized", () => {
    const auth = createApiKeyAuth({
      signingWalletId: "wal_default",
      walletBindings: [{ walletId: "wal_default", permissions: ["*"] }],
    });

    expect(resolveApiKeySigningWalletId(auth, "wal_default")).toBe("wal_default");
  });

  it("requires explicit walletId when multiple bindings exist without a default", () => {
    const auth = createApiKeyAuth({
      walletBindings: [
        { walletId: "wal_a", permissions: ["*"] },
        { walletId: "wal_b", permissions: ["*"] },
      ],
      signingWalletId: null,
    });

    expect(() => resolveApiKeySigningWalletId(auth, undefined)).toThrowError(AppError);
  });

  it("returns the list of allowed wallet IDs for API key auth", () => {
    const auth = createApiKeyAuth({
      walletBindings: [
        { walletId: "wal_a", permissions: ["*"] },
        { walletId: "wal_b", permissions: ["*"] },
      ],
    });

    expect(getAllowedApiKeyWalletIds(auth)).toEqual(["wal_a", "wal_b"]);
  });
});
