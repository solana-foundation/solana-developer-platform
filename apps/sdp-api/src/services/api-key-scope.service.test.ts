import { describe, expect, it } from "vitest";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  assertApiKeyWalletAccess,
  assertFreshApiKeyCustodyWalletAccess,
  assertGrantableApiKeyPermissions,
  filterApiKeyWallets,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
  getAllowedApiKeyWalletAuthorizationForPermissions,
  getAllowedApiKeyWalletIds,
  getAllowedApiKeyWalletIdsForPermissions,
  parseWalletBindingPatch,
  resolveApiKeyCustodyWalletId,
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

  it("treats an explicitly empty permissions list as deny-all, never wildcard", () => {
    // Regression (Hacktron): an admin restricting a wallet binding to zero
    // permissions must not silently grant full wildcard access instead.
    const auth = createApiKeyAuth({
      walletBindings: [{ walletId: "wal_restricted", permissions: [] }],
    });

    expect(() => assertApiKeyWalletAccess(auth, "wal_restricted", ["payments:read"])).toThrowError(
      AppError
    );
    expect(() => assertApiKeyWalletAccess(auth, "wal_restricted", ["custody:admin"])).toThrowError(
      AppError
    );
  });

  it("stores an explicitly empty permissions list instead of widening it to wildcard", () => {
    expect(
      resolveUpdateWalletScope({
        walletScope: "selected",
        walletBindings: [{ walletId: "wal_restricted", permissions: [] }],
      })
    ).toMatchObject({
      bindings: [{ walletId: "wal_restricted", permissions: [] }],
    });

    // Omitting permissions entirely keeps the historical unrestricted default.
    expect(
      resolveUpdateWalletScope({
        walletScope: "selected",
        signingWalletIds: ["wal_default"],
      })
    ).toMatchObject({
      bindings: [{ walletId: "wal_default", permissions: ["*"] }],
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

  it("keeps selected authorization pinned to exact custody wallet IDs", () => {
    const auth = createApiKeyAuth({
      walletScope: "selected",
      walletBindings: [
        {
          walletId: "wal_shared",
          custodyWalletId: "cwal_exact",
          permissions: ["wallets:read"],
        },
      ],
    });

    expect(getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["wallets:read"])).toEqual([
      "cwal_exact",
    ]);
    expect(resolveApiKeyCustodyWalletId(auth, "wal_shared", ["wallets:read"])).toBe("cwal_exact");
  });

  it("fails loudly when paired wallet authorization lacks an exact custody wallet ID", () => {
    const auth = createApiKeyAuth({
      walletScope: "selected",
      walletBindings: [{ walletId: "wal_legacy", permissions: ["payments:read"] }],
    });

    expect(() =>
      getAllowedApiKeyWalletAuthorizationForPermissions(auth, ["payments:read"])
    ).toThrowError(AppError);
  });

  it("fails closed when selected scope has no usable exact binding", () => {
    const auth = createApiKeyAuth({
      walletScope: "selected",
      signingWalletId: "wal_unresolved",
      walletBindings: [],
    });

    expect(getAllowedApiKeyCustodyWalletIdsForPermissions(auth)).toEqual([]);
    expect(() => resolveApiKeyCustodyWalletId(auth, "wal_unresolved")).toThrowError(AppError);
    expect(() => resolveApiKeySigningWalletId(auth, undefined)).toThrowError(AppError);
  });

  it("revalidates a cached exact binding before selected-wallet work", async () => {
    const auth = createApiKeyAuth({
      projectId: "prj_scope_test",
      walletScope: "selected",
      signingWalletId: "wal_shared",
      signingWalletIds: ["wal_shared"],
      walletBindings: [
        {
          walletId: "wal_shared",
          custodyWalletId: "cwlt_exact",
          permissions: ["payments:write"],
        },
      ],
    });
    const allResponses = [
      { results: [{ wallet_id: "wal_shared", permissions: '["payments:write"]' }] },
      {
        results: [
          { custody_wallet_id: "cwlt_exact", wallet_id: "wal_shared" },
          { custody_wallet_id: "cwlt_duplicate", wallet_id: "wal_shared" },
        ],
      },
    ];
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ signing_wallet_id: "wal_shared" }),
          all: async () => allResponses.shift(),
        }),
      }),
    } as unknown as Parameters<typeof assertFreshApiKeyCustodyWalletAccess>[0];

    await expect(
      assertFreshApiKeyCustodyWalletAccess(db, auth, "cwlt_exact", ["payments:write"])
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not authorize an exact row through a colliding Provider wallet ID", async () => {
    const auth = createApiKeyAuth({
      projectId: "prj_scope_test",
      walletScope: "selected",
      signingWalletId: "cwlt_exact",
      signingWalletIds: ["cwlt_exact"],
      walletBindings: [
        {
          walletId: "cwlt_exact",
          custodyWalletId: "cwlt_other",
          permissions: ["payments:write"],
        },
      ],
    });
    const allResponses = [
      { results: [{ wallet_id: "cwlt_exact", permissions: '["payments:write"]' }] },
      { results: [{ custody_wallet_id: "cwlt_other", wallet_id: "cwlt_exact" }] },
    ];
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ signing_wallet_id: "cwlt_exact" }),
          all: async () => allResponses.shift(),
        }),
      }),
    } as unknown as Parameters<typeof assertFreshApiKeyCustodyWalletAccess>[0];

    await expect(
      assertFreshApiKeyCustodyWalletAccess(db, auth, "cwlt_exact", ["payments:write"])
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("authorizes an exact row regardless of a preceding Provider wallet ID collision", async () => {
    const auth = createApiKeyAuth({
      projectId: "prj_scope_test",
      walletScope: "selected",
      signingWalletId: "wal_exact",
      signingWalletIds: ["wal_exact"],
      walletBindings: [
        {
          walletId: "wal_exact",
          custodyWalletId: "cwlt_exact",
          permissions: ["payments:write"],
        },
      ],
    });
    const allResponses = [
      {
        results: [
          { wallet_id: "cwlt_exact", permissions: '["payments:write"]' },
          { wallet_id: "wal_exact", permissions: '["payments:write"]' },
        ],
      },
      {
        results: [
          { custody_wallet_id: "cwlt_other", wallet_id: "cwlt_exact" },
          { custody_wallet_id: "cwlt_exact", wallet_id: "wal_exact" },
        ],
      },
    ];
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ signing_wallet_id: "wal_exact" }),
          all: async () => allResponses.shift(),
        }),
      }),
    } as unknown as Parameters<typeof assertFreshApiKeyCustodyWalletAccess>[0];

    await expect(
      assertFreshApiKeyCustodyWalletAccess(db, auth, "cwlt_exact", ["payments:write"])
    ).resolves.toBeUndefined();
  });

  it("requires an explicit wallet when the preferred binding is unresolved", () => {
    const auth = createApiKeyAuth({
      walletScope: "selected",
      signingWalletId: "wal_preferred",
      walletBindings: [
        {
          walletId: "wal_other",
          custodyWalletId: "cwal_other",
          permissions: ["wallets:read"],
        },
      ],
    });

    expect(() => resolveApiKeySigningWalletId(auth, undefined, ["wallets:read"])).toThrowError(
      AppError
    );
    expect(() => resolveApiKeyCustodyWalletId(auth, undefined, ["wallets:read"])).toThrowError(
      AppError
    );
    expect(resolveApiKeySigningWalletId(auth, "wal_other", ["wallets:read"])).toBe("wal_other");
    expect(resolveApiKeyCustodyWalletId(auth, "wal_other", ["wallets:read"])).toBe("cwal_other");
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

  it("rejects connectionId without wallet provisioning", () => {
    expect(() =>
      resolveCreateWalletScope({
        walletScope: "selected",
        connectionId: "cconn_selected",
      })
    ).toThrowError("connectionId requires provisionWallet");
  });

  it("accepts connectionId for selected wallet provisioning", () => {
    expect(
      resolveCreateWalletScope({
        walletScope: "selected",
        provisionWallet: true,
        connectionId: "cconn_selected",
      })
    ).toMatchObject({ walletScope: "selected", bindings: [] });
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

describe("assertGrantableApiKeyPermissions", () => {
  it("lets wildcard and org admins grant the api_admin role", () => {
    expect(() => assertGrantableApiKeyPermissions(["*"], "api_admin", undefined)).not.toThrow();
    expect(() =>
      assertGrantableApiKeyPermissions(["org:admin", "api-keys:write"], "api_admin", undefined)
    ).not.toThrow();
  });

  it("blocks a non-admin api-keys:write holder from minting an api_admin key", () => {
    expect(() =>
      assertGrantableApiKeyPermissions(["api-keys:write"], "api_admin", undefined)
    ).toThrowError(AppError);
  });

  it("blocks escalation through a custom permissions array the actor lacks", () => {
    expect(() =>
      assertGrantableApiKeyPermissions(["api-keys:write"], "api_developer", ["*"])
    ).toThrowError(AppError);
    expect(() =>
      assertGrantableApiKeyPermissions(["payments:read", "api-keys:write"], "api_developer", [
        "tokens:write",
      ])
    ).toThrowError(AppError);
  });

  it("blocks the default api_developer role when the actor lacks those permissions", () => {
    expect(() =>
      assertGrantableApiKeyPermissions(["api-keys:write"], "api_developer", undefined)
    ).toThrowError(AppError);
  });

  it("allows a non-admin to grant a subset of its own permissions", () => {
    expect(() =>
      assertGrantableApiKeyPermissions(
        ["payments:read", "payments:write", "api-keys:write"],
        "api_developer",
        ["payments:read"]
      )
    ).not.toThrow();
  });

  it("treats an empty permission set as always grantable", () => {
    expect(() =>
      assertGrantableApiKeyPermissions(["api-keys:write"], "api_developer", [])
    ).not.toThrow();
  });
});

function createApiKeyAuth(
  overrides: Partial<Omit<ApiKeyContext, "authType" | "apiKeyId" | "userId">> = {}
): ApiKeyContext {
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
