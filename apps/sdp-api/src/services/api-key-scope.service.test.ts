import { describe, expect, it } from "vitest";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  assertApiKeyWalletAccess,
  filterApiKeyWallets,
  getAllowedApiKeyWalletIds,
  getAllowedApiKeyWalletIdsForPermissions,
  parseWalletBindingPatch,
  resolveApiKeySigningWalletId,
  resolveCreateWalletScope,
  resolveUpdateWalletScope,
} from "./api-key-scope.service";

describe("api key scope service", () => {
  it("keeps all-wallet scope unbound and selected scope explicitly wallet-bound", () => {
    expect(
      resolveCreateWalletScope({
        walletScope: "all",
      })
    ).toEqual({
      walletScope: "all",
      defaultSigningWalletId: null,
      bindings: [],
    });

    expect(
      resolveUpdateWalletScope({
        walletScope: "selected",
        walletBindings: [{ walletId: "wal_selected", permissions: ["payments:write"] }],
      })
    ).toMatchObject({
      walletScope: "selected",
      defaultSigningWalletId: "wal_selected",
      bindings: [{ walletId: "wal_selected", permissions: ["payments:write"] }],
      touched: true,
    });
  });

  it("enforces wallet-level permissions for selected-scope API keys", () => {
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_selected", permissions: ["payments:read"] }],
    });

    expect(() => assertApiKeyWalletAccess(auth, "wal_selected", ["payments:read"])).not.toThrow();
    expect(() => assertApiKeyWalletAccess(auth, "wal_selected", ["payments:write"])).toThrowError(
      AppError
    );
  });

  it("allows unbound keys to access wallets for legacy all-wallet behavior", () => {
    const auth = createApiKeyAuth();
    expect(() => assertApiKeyWalletAccess(auth, "any_wallet", ["payments:write"])).not.toThrow();
  });

  it("rejects wallets that are not bound to the API key", () => {
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_a", permissions: ["*"] }],
    });

    expect(() => assertApiKeyWalletAccess(auth, "wal_b")).toThrowError(AppError);
  });

  it("resolves the requested signing wallet when authorized", () => {
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

  it("lists and filters allowed wallet IDs for API key auth", () => {
    const auth = createApiKeyAuth({
      walletBindings: [
        { walletId: "wal_read", permissions: ["wallets:read"] },
        { walletId: "wal_write", permissions: ["wallets:write"] },
      ],
    });

    expect(getAllowedApiKeyWalletIds(auth)).toEqual(["wal_read", "wal_write"]);
    expect(getAllowedApiKeyWalletIdsForPermissions(auth, ["wallets:read"])).toEqual(["wal_read"]);
  });

  it("filters wallet collections to the bound wallet set", () => {
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_a", permissions: ["wallets:read"] }],
    });

    expect(
      filterApiKeyWallets(
        auth,
        [
          { walletId: "wal_a", label: "A" },
          { walletId: "wal_b", label: "B" },
        ],
        ["wallets:read"]
      )
    ).toEqual([{ walletId: "wal_a", label: "A" }]);
  });

  it("supports legacy single signingWalletId payloads", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletId: "wal_legacy",
    });

    expect(parsed.defaultSigningWalletId).toBe("wal_legacy");
    expect(parsed.bindings).toEqual([{ walletId: "wal_legacy", permissions: ["*"] }]);
  });

  it("merges signingWalletIds and walletBindings", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletIds: ["wal_a", "wal_b"],
      walletBindings: [
        { walletId: "wal_b", permissions: ["payments:write"] },
        { walletId: "wal_c", permissions: ["tokens:write"] },
      ],
    });

    expect(parsed.defaultSigningWalletId).toBe("wal_b");
    expect(parsed.bindings).toEqual([
      { walletId: "wal_b", permissions: ["payments:write"] },
      { walletId: "wal_c", permissions: ["tokens:write"] },
      { walletId: "wal_a", permissions: ["*"] },
    ]);
  });

  it("clears all wallet bindings when a null patch is provided", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletIds: null,
    });

    expect(parsed.defaultSigningWalletId).toBeNull();
    expect(parsed.bindings).toEqual([]);
  });

  it("rejects conflicting null and non-null wallet patch fields", () => {
    expect(() =>
      parseWalletBindingPatch({
        signingWalletIds: null,
        signingWalletId: "wal_conflict",
      })
    ).toThrowError(AppError);
  });

  it("requires wallet bindings when walletScope is selected on create", () => {
    expect(() =>
      resolveCreateWalletScope({
        walletScope: "selected",
      })
    ).toThrowError(AppError);
  });

  it("rejects wallet binding fields when walletScope is all on create", () => {
    expect(() =>
      resolveCreateWalletScope({
        walletScope: "all",
        signingWalletId: "wal_all_conflict",
      })
    ).toThrowError(AppError);
  });

  it("treats walletScope all as a wallet binding reset on update", () => {
    const parsed = resolveUpdateWalletScope({
      walletScope: "all",
    });

    expect(parsed.touched).toBe(true);
    expect(parsed.defaultSigningWalletId).toBeNull();
    expect(parsed.bindings).toEqual([]);
  });

  it("requires walletScope when updating wallet bindings", () => {
    expect(() =>
      resolveUpdateWalletScope({
        signingWalletId: "wal_missing_scope",
      })
    ).toThrowError(AppError);
  });
});

function createApiKeyAuth(overrides: Partial<ApiKeyContext> = {}): ApiKeyContext {
  return {
    id: "key_scope_test",
    organizationId: "org_scope_test",
    projectId: null,
    role: "api_developer",
    permissions: ["*"],
    environment: "sandbox",
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    authType: "api_key",
    userId: null,
    apiKeyId: "key_scope_test",
    ...overrides,
  };
}
