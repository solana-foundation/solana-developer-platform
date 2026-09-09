import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPolicyEnabled: vi.fn(),
  listPolicies: vi.fn(),
  syncPolicy: vi.fn(),
  closeDatabasePools: vi.fn(),
  closeAllRedisClients: vi.fn(),
}));

vi.mock("../db", () => ({
  getDb: vi.fn(),
  runWithSystemDatabaseIdentity: (_name: string, fn: () => Promise<void>) => fn(),
  closeDatabasePools: mocks.closeDatabasePools,
}));
vi.mock("../db/repositories/sponsorship-budget.repository", () => ({
  SponsorshipBudgetRepository: class {
    setPolicyEnabled = mocks.setPolicyEnabled;
    listPolicies = mocks.listPolicies;
  },
}));
vi.mock("../lib/runtime-env", () => ({ getProcessEnv: () => ({}) }));
vi.mock("../runtime/sponsorship-budget-redis", () => ({
  SponsorshipBudgetRedis: class {
    syncPolicy = mocks.syncPolicy;
  },
}));
vi.mock("../runtime/kv-redis", () => ({ closeAllRedisClients: mocks.closeAllRedisClients }));

const policy = {
  id: "sbp_devnet_global",
  scopeType: "global",
  scopeId: null,
  enabled: true,
  version: 3,
  perTransactionLamports: 10_000_000,
  hourlyLamports: 2_000_000_000,
  dailyLamports: 10_000_000_000,
};
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

async function run(network = "devnet") {
  process.argv = [
    "node",
    "sponsorship-budget.js",
    "resume",
    "--network",
    network,
    "--operator",
    "github:operator",
    "--reason",
    "Reviewed dev incident",
  ];
  await import("../../scripts/sponsorship-budget");
  await vi.waitFor(() => expect(mocks.closeAllRedisClients).toHaveBeenCalledOnce());
}

describe("sponsorship operator CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    mocks.setPolicyEnabled.mockResolvedValue(policy);
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("resumes the global policy without changing limits and closes both clients", async () => {
    await run();
    expect(mocks.setPolicyEnabled).toHaveBeenCalledWith({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: true,
      operator: "github:operator",
      reason: "Reviewed dev incident",
    });
    expect(mocks.syncPolicy).toHaveBeenCalledWith(policy);
    expect(mocks.closeDatabasePools).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it("repairs Redis on an idempotent resume without a second database revision", async () => {
    mocks.setPolicyEnabled.mockResolvedValue(null);
    mocks.listPolicies.mockResolvedValue([policy]);
    await run();
    expect(mocks.syncPolicy).toHaveBeenCalledWith(policy);
    expect(mocks.setPolicyEnabled).toHaveBeenCalledOnce();
  });

  it("fails and closes clients when Redis synchronization fails", async () => {
    mocks.syncPolicy.mockRejectedValue(new Error("Redis unavailable"));
    await run();
    expect(process.exitCode).toBe(1);
    expect(mocks.closeDatabasePools).toHaveBeenCalledOnce();
  });

  it("rejects an invalid network before changing any policy", async () => {
    await run("invalid");
    expect(mocks.setPolicyEnabled).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
