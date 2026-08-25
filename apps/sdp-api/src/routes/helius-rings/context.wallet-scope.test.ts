import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wallet-level authorization, which the route permission does not provide.
 *
 * `requirePermissions("payments:write")` says what a caller may do; it says
 * nothing about which wallet. Without these guards a key scoped to one custody
 * wallet could list this project's rings wallet ids and then spend from any of
 * them. Payments enforces the same check on its equivalent operations.
 */

const AUTH = { authType: "api_key", organizationId: "org_1", apiKeyId: "key_1" };

const WALLET = {
  id: "hrw_1",
  // The provider id an API-key binding names — not the rings id in the URL.
  sdp_wallet_id: "wal_provider_1",
};

const { assertApiKeyWalletAccess, getAllowedApiKeyWalletIdsForPermissions } = vi.hoisted(() => ({
  assertApiKeyWalletAccess: vi.fn(),
  getAllowedApiKeyWalletIdsForPermissions: vi.fn(),
}));
const { getWalletById, getOperationById } = vi.hoisted(() => ({
  getWalletById: vi.fn(),
  getOperationById: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuth: () => AUTH, requireProjectId: () => "proj_1" }));
vi.mock("@/services/api-key-scope.service", () => ({
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
}));
vi.mock("@/db/repositories", () => ({
  createHeliusRingsWalletRepository: () => ({ getWalletById }),
  createHeliusRingsOperationRepository: () => ({ getOperationById }),
  createHeliusRingsZoneRepository: () => ({}),
}));
vi.mock("@/services/helius-rings", () => ({ createHeliusRingsService: () => ({}) }));

const { allowedRingsWalletIds, requireRingsOperation, requireRingsWallet } = await import(
  "./context"
);

const c = {} as never;
const tenant = { organizationId: "org_1", projectId: "proj_1" };

beforeEach(() => {
  // `reset` rather than `clear`: one test below makes the scope check throw, and
  // a cleared mock keeps its implementation.
  vi.resetAllMocks();
  getWalletById.mockResolvedValue(WALLET);
});

describe("requireRingsWallet", () => {
  it("checks the key against the custody wallet behind the rings wallet", async () => {
    await requireRingsWallet(c, tenant, "hrw_1", ["payments:write"]);

    // The provider id, because that is what a binding names. Passing the rings
    // id would type-check and always pass, which is the failure mode worth
    // pinning.
    expect(assertApiKeyWalletAccess).toHaveBeenCalledWith(AUTH, "wal_provider_1", [
      "payments:write",
    ]);
  });

  it("refuses when the scope check refuses", async () => {
    assertApiKeyWalletAccess.mockImplementation(() => {
      throw new Error("API key is not authorized for the requested wallet");
    });

    await expect(requireRingsWallet(c, tenant, "hrw_1", ["payments:write"])).rejects.toThrow(
      "not authorized"
    );
  });

  it("reports a missing wallet before consulting the scope", async () => {
    getWalletById.mockResolvedValue(null);

    await expect(requireRingsWallet(c, tenant, "hrw_missing", ["payments:read"])).rejects.toThrow();
    // A caller that cannot see the wallet learns the same thing either way, and
    // an unknown id must not read as a permission problem.
    expect(assertApiKeyWalletAccess).not.toHaveBeenCalled();
  });
});

describe("requireRingsOperation", () => {
  it("checks the wallet the operation belongs to", async () => {
    getOperationById.mockResolvedValue({ id: "hro_1", wallet_id: "hrw_1" });

    await requireRingsOperation(c, tenant, "hro_1", ["payments:write"]);

    // Reached through the operation, so a key cannot execute or reconcile
    // someone else's operation by naming its id.
    expect(assertApiKeyWalletAccess).toHaveBeenCalledWith(AUTH, "wal_provider_1", [
      "payments:write",
    ]);
  });

  it("reports a missing operation without touching the scope", async () => {
    getOperationById.mockResolvedValue(null);

    await expect(requireRingsOperation(c, tenant, "hro_x", ["payments:read"])).rejects.toThrow();
    expect(assertApiKeyWalletAccess).not.toHaveBeenCalled();
  });
});

describe("allowedRingsWalletIds", () => {
  it("is null for a key with no wallet scope, so nothing is filtered", () => {
    getAllowedApiKeyWalletIdsForPermissions.mockReturnValue(null);

    expect(allowedRingsWalletIds(c, ["payments:read"])).toBeNull();
  });

  it("is the permitted set for a scoped key", () => {
    getAllowedApiKeyWalletIdsForPermissions.mockReturnValue(["wal_provider_1"]);

    const allowed = allowedRingsWalletIds(c, ["payments:read"]);

    // Lists filter rather than throw: a scoped key asking for its wallets
    // wants its own, not a 403.
    expect(allowed?.has("wal_provider_1")).toBe(true);
    expect(allowed?.has("wal_provider_2")).toBe(false);
  });
});
