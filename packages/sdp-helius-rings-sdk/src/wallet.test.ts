import { beforeEach, describe, expect, it, vi } from "vitest";

const syncWallet = vi.fn();

vi.mock("@heliuslabs/zolana", () => ({
  Wallet: class {},
}));

vi.mock("@heliuslabs/zolana/wallet", () => ({
  syncWallet: (...args: unknown[]) => syncWallet(...args),
}));

const { hydrateWallet } = await import("./wallet.js");

const CLEAN = {
  storedUtxos: 0,
  unparsedTransactions: 0,
  undecryptableCandidates: 0,
  unknownAssetIds: [],
  unknownAssetFields: [],
};

const INPUT = {
  client: {} as never,
  material: { shieldedAddress: {} } as never,
  authority: {} as never,
};

describe("hydrateWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncWallet.mockResolvedValue(CLEAN);
  });

  it.each([
    ["unparsed transactions", { unparsedTransactions: 1 }],
    ["undecryptable candidates", { undecryptableCandidates: 1 }],
    ["unknown asset ids", { unknownAssetIds: [9n, 10n] }],
    [
      "unknown asset fields",
      { unknownAssetFields: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)] },
    ],
  ])("refuses to select notes when sync reports %s", async (_name, anomaly) => {
    syncWallet.mockResolvedValue({ ...CLEAN, ...anomaly });

    await expect(hydrateWallet({ ...INPUT, requireComplete: true })).rejects.toMatchObject({
      code: "gateway_unavailable",
    });
  });

  it("allows note selection after a complete sync", async () => {
    const { report } = await hydrateWallet({ ...INPUT, requireComplete: true });

    expect(report).toBe(CLEAN);
  });
});
