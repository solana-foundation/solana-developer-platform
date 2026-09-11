import { beforeEach, describe, expect, it, vi } from "vitest";

const syncWallet = vi.fn();
const getPrivateTransactions = vi.fn();
const utxos = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  syncWallet: (...args: unknown[]) => syncWallet(...args),
  getPrivateTransactions: (...args: unknown[]) => getPrivateTransactions(...args),
}));

vi.mock("@heliuslabs/zolana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana")>()),
  Wallet: class {
    utxos = utxos;
  },
}));

const { HeliusRingsError } = await import("@sdp/helius-rings");
const { syncRingsWallet } = await import("./sync.js");
const { derivedIdentity, TEST_OWNER, testMaterialSource } = await import(
  "./test/shielded-identity-fixtures.js"
);

const OWNER = TEST_OWNER;
const PROTOCOL_SOL = "11111111111111111111111111111111";
const SDP_SOL = "So11111111111111111111111111111111111111112";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// Distinct from every other address here so a swapped parameter cannot pass.
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";
const OTHER_RING = "SysvarRent111111111111111111111111111111111";

const SOL_LABEL = { mint: SDP_SOL, symbol: "SOL", decimals: 9 };

const DEPS = {
  client: {} as never,
  material: testMaterialSource(),
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
    getPrivateTransactions.mockReturnValue([]);
    utxos.mockReturnValue([]);
  });

  it("tags every unspent note's balance by its ring, default bucket first", async () => {
    utxos.mockReturnValue([
      { spent: false, utxo: { ringProgramId: RING_PROGRAM, asset: PROTOCOL_SOL, amount: 2n } },
      { spent: false, utxo: { ringProgramId: RING_PROGRAM, asset: PROTOCOL_SOL, amount: 3n } },
      // Unbound: only the default pool's flows can spend it, so its own row.
      { spent: false, utxo: { asset: PROTOCOL_SOL, amount: 100n } },
      // A foreign ring's note is unspendable through this project's flows, but
      // hiding it would misreport what the identity holds.
      { spent: false, utxo: { ringProgramId: OTHER_RING, asset: PROTOCOL_SOL, amount: 200n } },
      { spent: true, utxo: { ringProgramId: RING_PROGRAM, asset: PROTOCOL_SOL, amount: 400n } },
      { spent: false, utxo: { ringProgramId: RING_PROGRAM, asset: USDC, amount: 7n } },
    ]);

    const { balances } = await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      knownAssets: [SOL_LABEL],
    });

    // Value cannot cross a ring boundary inside a spend, so nothing merges.
    // `noteCount` is per position for the same reason: the ring's 5 spans two
    // notes, and only a per-position count can say a merge would help there.
    expect(balances).toEqual([
      {
        mint: SDP_SOL,
        symbol: "SOL",
        decimals: 9,
        amountRaw: "100",
        ringProgramId: null,
        noteCount: 1,
      },
      {
        mint: SDP_SOL,
        symbol: "SOL",
        decimals: 9,
        amountRaw: "5",
        ringProgramId: RING_PROGRAM,
        noteCount: 2,
      },
      {
        mint: USDC,
        symbol: "UNKNOWN",
        decimals: 0,
        amountRaw: "7",
        ringProgramId: RING_PROGRAM,
        noteCount: 1,
      },
      {
        mint: SDP_SOL,
        symbol: "SOL",
        decimals: 9,
        amountRaw: "200",
        ringProgramId: OTHER_RING,
        noteCount: 1,
      },
    ]);
  });

  it("reports SOL under the mint SDP uses, not the protocol's", async () => {
    utxos.mockReturnValue([
      { spent: false, utxo: { asset: PROTOCOL_SOL, amount: 2_500_000_000n } },
    ]);

    const result = await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      knownAssets: [SOL_LABEL],
    });

    // The protocol spells native SOL as the system program and SDP spells it as
    // wrapped SOL. Returning the protocol's would miss every allowlist lookup.
    expect(result.balances).toEqual([
      {
        mint: SDP_SOL,
        symbol: "SOL",
        decimals: 9,
        amountRaw: "2500000000",
        ringProgramId: null,
        noteCount: 1,
      },
    ]);
  });

  it("still returns a holding whose mint is not on the allowlist", async () => {
    utxos.mockReturnValue([{ spent: false, utxo: { asset: USDC, amount: 42n } }]);

    const [balance] = (await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER })).balances;

    // Dropping it would tell an operator the wallet is empty when it is not,
    // and guessing decimals would render the amount at the wrong magnitude.
    expect(balance).toEqual({
      mint: USDC,
      symbol: "UNKNOWN",
      decimals: 0,
      amountRaw: "42",
      ringProgramId: null,
      noteCount: 1,
    });
  });

  it("counts unspent notes", async () => {
    utxos.mockReturnValue([
      { spent: false, utxo: { asset: PROTOCOL_SOL, amount: 1n } },
      { spent: true, utxo: { asset: PROTOCOL_SOL, amount: 1n } },
      { spent: false, utxo: { asset: PROTOCOL_SOL, amount: 1n } },
    ]);

    const { report, balances } = await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    expect(report.storedNotes).toBe(2);
    // The same two notes, counted again per position: one number is the
    // wallet's total and the other is what makes a merge worth offering.
    expect(balances[0]?.noteCount).toBe(2);
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
    const expected = await derivedIdentity({
      organizationId: "org_1",
      projectId: "proj_1",
      walletId: "hrw_1",
      owner: OWNER,
    });

    await syncRingsWallet(DEPS, {
      walletId: "hrw_1",
      owner: OWNER,
      expectedShieldedAddress: expected,
    });

    expect(syncWallet).toHaveBeenCalledTimes(1);
  });

  it("hands the sync keys that can read but not prove", async () => {
    await syncRingsWallet(DEPS, { walletId: "hrw_1", owner: OWNER });

    const [{ keys }] = syncWallet.mock.calls[0] as [{ keys: object }];

    // Sync has no operation behind it, so nothing it holds should be able to
    // spend. Proving is a separate capability in 0.1.6, and the read path takes
    // the form that does not have it, so an SDK that tried would fail loudly.
    expect("derive" in keys).toBe(true);
    expect("decrypt" in keys).toBe(true);
    expect("prove" in keys).toBe(false);
    expect("proveMerge" in keys).toBe(false);
  });
});
