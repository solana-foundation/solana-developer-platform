import { beforeEach, describe, expect, it, vi } from "vitest";

const syncWallet = vi.fn();
const getPrivateTokenBalances = vi.fn();
const getPrivateTransactions = vi.fn();
const utxos = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  syncWallet: (...args: unknown[]) => syncWallet(...args),
  getPrivateTokenBalances: (...args: unknown[]) => getPrivateTokenBalances(...args),
  getPrivateTransactions: (...args: unknown[]) => getPrivateTransactions(...args),
}));

vi.mock("@heliuslabs/zolana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana")>()),
  Wallet: class {
    utxos = utxos;
  },
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { deriveMaterial } = await import("./deterministic-ka/derivation.js");
const { HeliusRingsError } = await import("@sdp/helius-rings");
const { canonicalShieldedIdentity } = await import("./material.js");
const { syncRingsWallet } = await import("./sync.js");

const SEED = new Uint8Array(32).fill(3);
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PROTOCOL_SOL = "11111111111111111111111111111111";
const SDP_SOL = "So11111111111111111111111111111111111111112";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const DEPS = {
  client: {} as never,
  material: createDeterministicMaterialSource({ seed: SEED }),
  organizationId: "org_1",
  projectId: "proj_1",
};

const CLEAN = {
  storedUtxos: 0,
  unparsedTransactions: 0,
  undecryptableCandidates: 0,
  unknownAssetIds: [],
  unknownAssetFields: [],
};
const UNKNOWN_ASSET_IDS = [9n, 10n, 11n];
const UNKNOWN_ASSET_FIELDS = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];

describe("syncRingsWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncWallet.mockResolvedValue(CLEAN);
    getPrivateTokenBalances.mockReturnValue([]);
    getPrivateTransactions.mockReturnValue([]);
    utxos.mockReturnValue([]);
  });

  it("reports SOL under the mint SDP uses, not the protocol's", async () => {
    getPrivateTokenBalances.mockReturnValue([
      { assetId: 1n, mint: PROTOCOL_SOL, amount: 2_500_000_000n, utxos: [] },
    ]);

    const result = await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      knownAssets: [{ mint: SDP_SOL, symbol: "SOL", decimals: 9 }],
    });

    // The protocol spells native SOL as the system program and SDP spells it as
    // wrapped SOL. Returning the protocol's would miss every allowlist lookup.
    expect(result.balances).toEqual([
      { mint: SDP_SOL, symbol: "SOL", decimals: 9, amountRaw: "2500000000" },
    ]);
  });

  it("still returns a holding whose mint is not on the allowlist", async () => {
    getPrivateTokenBalances.mockReturnValue([{ assetId: 9n, mint: USDC, amount: 42n, utxos: [] }]);

    const [balance] = (await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER })).balances;

    // Dropping it would tell an operator the wallet is empty when it is not,
    // and guessing decimals would render the amount at the wrong magnitude.
    expect(balance).toEqual({ mint: USDC, symbol: "UNKNOWN", decimals: 0, amountRaw: "42" });
  });

  it("counts unspent notes", async () => {
    utxos.mockReturnValue([{ spent: false }, { spent: true }, { spent: false }]);

    const { report } = await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    expect(report.storedNotes).toBe(2);
  });

  it.each([
    ["unparsed transactions", { unparsedTransactions: 2 }, { unparsedTransactions: 2 }],
    ["undecryptable candidates", { undecryptableCandidates: 3 }, { undecryptableCandidates: 3 }],
    [
      "unknown asset ids",
      { unknownAssetIds: UNKNOWN_ASSET_IDS },
      { unknownAssetIds: UNKNOWN_ASSET_IDS.length },
    ],
    [
      "unknown asset fields",
      { unknownAssetFields: UNKNOWN_ASSET_FIELDS },
      { unknownAssetFields: UNKNOWN_ASSET_FIELDS.length },
    ],
  ])("marks %s as degraded and returns its count", async (_name, anomaly, expected) => {
    syncWallet.mockResolvedValue({ ...CLEAN, ...anomaly });

    const { report } = await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    expect(report).toEqual({
      storedNotes: 0,
      unparsedTransactions: 0,
      undecryptableCandidates: 0,
      unknownAssetIds: 0,
      unknownAssetFields: 0,
      ...expected,
      degraded: true,
    });
  });

  it("returns zero anomaly counts and stays clean when nothing was missed", async () => {
    const { report } = await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    expect(report).toEqual({
      storedNotes: 0,
      unparsedTransactions: 0,
      undecryptableCandidates: 0,
      unknownAssetIds: 0,
      unknownAssetFields: 0,
      degraded: false,
    });
  });

  it("translates history rows into SDP's vocabulary", async () => {
    getPrivateTransactions.mockReturnValue([
      {
        id: { signature: "sig1", slot: 100n, index: 0n },
        kind: "deposit",
        direction: "inbound",
        asset: PROTOCOL_SOL,
        amount: 1n,
      },
      {
        id: { signature: "sig2", slot: 101n, index: 7n },
        kind: "publicWithdrawal",
        direction: "selfTransfer",
        asset: USDC,
        amount: 5n,
      },
    ]);

    const { history, indexedOperationSignatures } = await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
    });

    expect(history[0]).toEqual({
      signature: "sig1",
      slot: "100",
      index: "0",
      kind: "shield",
      direction: "inbound",
      mint: SDP_SOL,
      amountRaw: "1",
    });
    expect(history[1]?.kind).toBe("withdraw");
    expect(history[1]?.direction).toBe("self");
    expect(indexedOperationSignatures).toEqual(["sig1", "sig2"]);
  });

  it("refuses to sync when the material no longer derives the persisted identity", async () => {
    const error = await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      expectedShieldedAddress: "not-the-identity-this-seed-derives",
    }).catch((thrown: unknown) => thrown);

    // Syncing anyway would report a different identity's balances under this
    // wallet, which is worse than refusing to answer. Classified rather than
    // raw: the same inputs derive the same identity on every read, so the
    // operator needs a conflict they can act on and not a retry.
    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({ code: "conflict" });
    expect(syncWallet).not.toHaveBeenCalled();
  });

  it("proceeds when the persisted identity is the one the material derives", async () => {
    const material = await deriveMaterial(SEED, {
      organizationId: "org_1",
      projectId: "proj_1",
      walletId: "hrw_1",
      owner: OWNER,
    });
    const expected = canonicalShieldedIdentity(material.shieldedAddress);
    material.destroy();

    await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      expectedShieldedAddress: expected,
    });

    expect(syncWallet).toHaveBeenCalledTimes(1);
  });

  it("hands the sync an authority that can read but not spend", async () => {
    await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    const [{ authority }] = syncWallet.mock.calls[0] as [{ authority: Record<string, unknown> }];

    // Sync has no operation behind it, so there is no approval an authority
    // could honestly stand for. Anything beyond reading must be absent rather
    // than stubbed, so a future SDK that tried to spend here would fail loudly.
    expect(Object.keys(authority)).toEqual(["syncMaterial"]);
  });
});
