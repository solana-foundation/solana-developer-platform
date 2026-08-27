import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowedRingsWalletIds: vi.fn(),
  listOperationsByProject: vi.fn(),
  listWalletIdsBySdpWalletIds: vi.fn(),
  listWallets: vi.fn(),
  success: vi.fn((_context: unknown, body: unknown) => body),
}));

vi.mock("@/db/repositories", () => ({
  mapHeliusRingsOperationSummaryRow: (row: { id: string }) => ({ id: row.id }),
  mapHeliusRingsWalletRow: (row: { id: string }) => ({ id: row.id }),
  mapHeliusRingsZoneRow: (row: { id: string }) => ({ id: row.id }),
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ authType: "api_key", organizationId: "org_1" }),
  requireProjectId: () => "proj_1",
}));
vi.mock("@/lib/response", () => ({ success: mocks.success }));
vi.mock("./context", () => ({
  allowedRingsWalletIds: mocks.allowedRingsWalletIds,
  getHeliusRingsOperationRepository: () => ({
    listOperationsByProject: mocks.listOperationsByProject,
  }),
  getHeliusRingsService: () => ({}),
  getHeliusRingsWalletRepository: () => ({
    listWalletIdsBySdpWalletIds: mocks.listWalletIdsBySdpWalletIds,
    listWallets: mocks.listWallets,
  }),
  getHeliusRingsZoneRepository: () => ({}),
  requireParam: vi.fn(),
  requireRingsOperation: vi.fn(),
  requireRingsWallet: vi.fn(),
  withRingsErrors: vi.fn(),
}));

const { listRingsOperations, listRingsWallets } = await import("./handlers");

const context = {
  req: {
    query: () => "1",
  },
} as never;

const tenant = { organizationId: "org_1", projectId: "proj_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listOperationsByProject.mockResolvedValue([]);
  mocks.listWalletIdsBySdpWalletIds.mockResolvedValue([]);
  mocks.listWallets.mockResolvedValue([]);
});

describe("Rings list wallet scope", () => {
  it("passes allowed provider wallet ids into the wallet repository", async () => {
    mocks.allowedRingsWalletIds.mockReturnValue(new Set(["wal_provider_1"]));

    await listRingsWallets(context);

    expect(mocks.listWallets).toHaveBeenCalledWith({
      ...tenant,
      limit: 1,
      sdpWalletIds: ["wal_provider_1"],
    });
  });

  it("resolves allowed rings wallet ids before listing project operations", async () => {
    mocks.allowedRingsWalletIds.mockReturnValue(new Set(["wal_provider_1", "wal_provider_2"]));
    mocks.listWalletIdsBySdpWalletIds.mockResolvedValue(["hrw_1", "hrw_2"]);

    await listRingsOperations(context);

    expect(mocks.listWalletIdsBySdpWalletIds).toHaveBeenCalledWith({
      ...tenant,
      sdpWalletIds: ["wal_provider_1", "wal_provider_2"],
    });
    expect(mocks.listOperationsByProject).toHaveBeenCalledWith({
      ...tenant,
      limit: 1,
      walletIds: ["hrw_1", "hrw_2"],
    });
  });

  it("keeps unrestricted repository list inputs unchanged", async () => {
    mocks.allowedRingsWalletIds.mockReturnValue(null);

    await listRingsWallets(context);
    await listRingsOperations(context);

    expect(mocks.listWallets).toHaveBeenCalledWith({ ...tenant, limit: 1 });
    expect(mocks.listWalletIdsBySdpWalletIds).not.toHaveBeenCalled();
    expect(mocks.listOperationsByProject).toHaveBeenCalledWith({ ...tenant, limit: 1 });
  });
});
