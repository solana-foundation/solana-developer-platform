import { HeliusRingsError } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  derivedIdentity,
  TEST_OWNER,
  TEST_REQUEST,
  TEST_SEED,
} from "./test/shielded-identity-fixtures.js";

const syncWallet = vi.fn();
const getPrivateTransactions = vi.fn();
const walletUtxos = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  syncWallet: (...args: unknown[]) => syncWallet(...args),
  getPrivateTransactions: (...args: unknown[]) => getPrivateTransactions(...args),
}));

vi.mock("@heliuslabs/zolana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana")>()),
  Wallet: class {
    utxos(): unknown[] {
      return walletUtxos();
    }
  },
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { RingsIdentityMismatchError } = await import("./material.js");
const { syncRingsWallet } = await import("./sync.js");

const OWNER = TEST_OWNER;
const PROTOCOL_SOL = "11111111111111111111111111111111";
const SDP_SOL = "So11111111111111111111111111111111111111112";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// Distinct from TEST_OWNER so a swapped parameter cannot pass.
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";
const OTHER_RING = "SysvarRent111111111111111111111111111111111";

const DEPS = {
  client: {} as never,
  material: createDeterministicMaterialSource({ seed: TEST_SEED }),
  organizationId: TEST_REQUEST.organizationId,
  projectId: TEST_REQUEST.projectId,
};

const INPUT = { walletId: TEST_REQUEST.walletId, owner: OWNER, cursor: null };

/** The canonical identity this seed derives for one wallet of the tenant. */
const identityOf = (walletId: string) => derivedIdentity({ ...TEST_REQUEST, walletId });

const CLEAN = {
  storedUtxos: 0,
  unparsedTransactions: 0,
  undecryptableCandidates: 0,
  unknownAssetIds: [],
  unknownAssetFields: [],
};

describe("syncRingsWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncWallet.mockResolvedValue(CLEAN);
    getPrivateTransactions.mockReturnValue([]);
    walletUtxos.mockReturnValue([]);
  });

  it("tags every unspent note's balance by its ring, default bucket first", async () => {
    walletUtxos.mockReturnValue([
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

    const { balances } = await syncRingsWallet(DEPS, INPUT);

    // Value cannot cross a ring boundary inside a spend, so nothing merges.
    expect(balances).toEqual([
      { mint: SDP_SOL, symbol: "SOL", decimals: 9, amountRaw: "100", ringProgramId: null },
      { mint: SDP_SOL, symbol: "SOL", decimals: 9, amountRaw: "5", ringProgramId: RING_PROGRAM },
      {
        mint: USDC,
        symbol: "UNKNOWN",
        decimals: null,
        amountRaw: "7",
        ringProgramId: RING_PROGRAM,
      },
      { mint: SDP_SOL, symbol: "SOL", decimals: 9, amountRaw: "200", ringProgramId: OTHER_RING },
    ]);
  });

  it("reports SOL under the mint SDP uses, not the protocol's", async () => {
    walletUtxos.mockReturnValue([
      { spent: false, utxo: { asset: PROTOCOL_SOL, amount: 2_500_000_000n } },
    ]);

    const { balances } = await syncRingsWallet(DEPS, INPUT);

    // Returning the protocol's spelling would miss every allowlist lookup.
    expect(balances).toEqual([
      { mint: SDP_SOL, symbol: "SOL", decimals: 9, amountRaw: "2500000000", ringProgramId: null },
    ]);
  });

  it("still returns a holding whose mint it cannot label", async () => {
    walletUtxos.mockReturnValue([{ spent: false, utxo: { asset: USDC, amount: 1_500_000n } }]);

    const [balance] = (await syncRingsWallet(DEPS, INPUT)).balances;

    // Dropping it would report an empty wallet and guessing decimals would
    // render the wrong magnitude; null says the scale is unknown, so the
    // renderer shows base units rather than reading 1.50 USDC as 1500000.
    expect(balance).toEqual({
      mint: USDC,
      symbol: "UNKNOWN",
      decimals: null,
      amountRaw: "1500000",
      ringProgramId: null,
    });
  });

  it.each([
    ["unparsed transactions", { unparsedTransactions: 2 }],
    ["undecryptable candidates", { undecryptableCandidates: 3 }],
    ["unknown asset ids", { unknownAssetIds: [9n, 10n] }],
    ["unknown asset fields", { unknownAssetFields: [new Uint8Array(32).fill(1)] }],
  ])("reports %s as degraded while still returning balances", async (_name, anomaly) => {
    syncWallet.mockResolvedValue({ ...CLEAN, ...anomaly });
    walletUtxos.mockReturnValue([{ spent: false, utxo: { asset: PROTOCOL_SOL, amount: 1n } }]);

    const result = await syncRingsWallet(DEPS, INPUT);

    expect(result.degraded).toBe(true);
    expect(result.balances).toHaveLength(1);
  });

  it("stays clean when nothing was missed", async () => {
    await expect(syncRingsWallet(DEPS, INPUT)).resolves.toMatchObject({ degraded: false });
  });

  it("returns the signatures its rows were reconstructed from, deduplicated", async () => {
    getPrivateTransactions.mockReturnValue([
      { id: { signature: "sig1", slot: 100n, index: 0n } },
      { id: { signature: "sig2", slot: 101n, index: 0n } },
      { id: { signature: "sig1", slot: 100n, index: 1n } },
    ]);

    const { indexedOperationSignatures } = await syncRingsWallet(DEPS, INPUT);

    expect(indexedOperationSignatures).toEqual(["sig1", "sig2"]);
  });

  it("returns the moment it observed as the cursor", async () => {
    const before = Date.now();

    const { cursor } = await syncRingsWallet(DEPS, INPUT);

    // Not a resume position: every sync is a full read, so this only says when
    // the answer was true.
    expect(Date.parse(cursor)).toBeGreaterThanOrEqual(before);
    expect(cursor).toBe(new Date(cursor).toISOString());
  });

  it("reads the whole wallet regardless of the cursor it was handed", async () => {
    await syncRingsWallet(DEPS, { ...INPUT, cursor: "2026-01-01T00:00:00.000Z" });

    const [call] = syncWallet.mock.calls as [[Record<string, unknown>]];
    expect(call[0]).not.toHaveProperty("config");
  });

  it("refuses to sync when the material no longer derives the persisted identity", async () => {
    const error = await syncRingsWallet(DEPS, {
      ...INPUT,
      expectedShieldedAddress: await identityOf("hrw_restored_from_elsewhere"),
    }).catch((thrown: unknown) => thrown);

    // Syncing anyway would report a different identity's balances under this
    // wallet.
    expect(syncWallet).not.toHaveBeenCalled();
    // And it refuses as a domain failure; untranslated the mismatch reaches the
    // operator as an opaque 500.
    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).not.toBeInstanceOf(RingsIdentityMismatchError);
    // `conflict` is a 409: the same read repeated fails the same way.
    expect(error).toMatchObject({ code: "conflict" });
  });

  it("reports the mismatch without naming either identity", async () => {
    const persisted = await identityOf("hrw_restored_from_elsewhere");
    const derived = await identityOf("hrw_1");

    const error = (await syncRingsWallet(DEPS, {
      ...INPUT,
      expectedShieldedAddress: persisted,
    }).catch((thrown: unknown) => thrown)) as Error;

    // An operator can act on neither shielded address the raw error carries, so
    // the bridged failure names the seed and owner instead and keeps the raw
    // error unreachable as a cause.
    const reachable = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(reachable).not.toContain(derived);
    expect(reachable).not.toContain(persisted);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe(
      "the Rings identity derived for this wallet is not the one it was provisioned with; check the wallet's owner and the organization and project it was provisioned under"
    );
  });

  it("proceeds when the persisted identity is the one the material derives", async () => {
    await syncRingsWallet(DEPS, { ...INPUT, expectedShieldedAddress: await identityOf("hrw_1") });

    expect(syncWallet).toHaveBeenCalledTimes(1);
  });

  it("hands the sync an authority that can read but not spend", async () => {
    await syncRingsWallet(DEPS, INPUT);

    const [{ authority }] = syncWallet.mock.calls[0] as [{ authority: Record<string, unknown> }];

    // Sync has no operation behind it, so there is no approval an authority could
    // stand for; anything beyond reading must be absent rather than stubbed.
    expect(Object.keys(authority)).toEqual(["syncMaterial"]);
  });
});
