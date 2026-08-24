import { HeliusRingsError } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildRegistrationTransaction = vi.fn();
const buildSetMergingEnabledTransaction = vi.fn();
const fetchUserRecord = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildRegistrationTransaction: (...args: unknown[]) => buildRegistrationTransaction(...args),
  buildSetMergingEnabledTransaction: (...args: unknown[]) =>
    buildSetMergingEnabledTransaction(...args),
  fetchUserRecord: (...args: unknown[]) => fetchUserRecord(...args),
}));

vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  // The chain is mocked, so the "transactions" here are markers rather than
  // encodable messages; only their journey through sign and submit matters.
  getTransactionEncoder: () => ({ encode: () => new Uint8Array([1, 2, 3]) }),
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { deriveMaterial } = await import("./deterministic-ka/derivation.js");
const { provisionRingsIdentity } = await import("./provision.js");

const SEED = new Uint8Array(32).fill(7);
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const REQUEST = {
  organizationId: "org_1",
  projectId: "proj_1",
  walletId: "hrw_1",
  owner: OWNER,
};

/** The record the seed above genuinely derives, so a match is a real match. */
async function honestRecord(mergingEnabled: boolean) {
  const material = await deriveMaterial(SEED, REQUEST);
  try {
    return {
      owner: OWNER,
      nullifierPublicKey: material.nullifierKey.publicKey(),
      viewingPublicKey: material.viewingKey.publicKey().toBytes(),
      mergingEnabled,
      bump: 255,
    };
  } finally {
    material.destroy();
  }
}

function deps(overrides: Partial<Parameters<typeof provisionRingsIdentity>[0]> = {}) {
  return {
    client: { confirmTransaction: vi.fn().mockResolvedValue(1n) } as never,
    material: createDeterministicMaterialSource({ seed: SEED }),
    signTransaction: vi.fn(async (unsigned: string) => `signed:${unsigned}`),
    submitTransaction: vi.fn(async (signed: string) => `sig-for-${signed.length}`),
    organizationId: "org_1",
    projectId: "proj_1",
    ...overrides,
  };
}

describe("provisionRingsIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSetMergingEnabledTransaction.mockResolvedValue({ kind: "merging" });
  });

  it("registers, enables merging, and verifies the record it just wrote", async () => {
    buildRegistrationTransaction.mockResolvedValue({ kind: "registration" });
    fetchUserRecord
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(await honestRecord(true));

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result.registrationSignatures).toHaveLength(2);
    expect(result.mergingEnabled).toBe(true);
    expect(result.materialTag).toBe("live");
    expect(result.identity.owner).toBe(OWNER);
    // Custody signs both; the gateway never holds the owner's secret itself.
    expect(wiring.signTransaction).toHaveBeenCalledTimes(2);
    expect(wiring.submitTransaction).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the identity is already registered and merging", async () => {
    // What a retry after a fully successful provision looks like: the SDK
    // declines to rebuild a registration, and merging is already on.
    buildRegistrationTransaction.mockResolvedValue(undefined);
    const record = await honestRecord(true);
    fetchUserRecord.mockResolvedValue(record);

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result.registrationSignatures).toEqual([]);
    expect(result.mergingEnabled).toBe(true);
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
    expect(buildSetMergingEnabledTransaction).not.toHaveBeenCalled();
  });

  it("finishes a provision that registered but never enabled merging", async () => {
    buildRegistrationTransaction.mockResolvedValue(undefined);
    fetchUserRecord
      .mockResolvedValueOnce(await honestRecord(false))
      .mockResolvedValueOnce(await honestRecord(true));

    const result = await provisionRingsIdentity(deps(), { walletId: "hrw_1", owner: OWNER });

    expect(result.registrationSignatures).toHaveLength(1);
    expect(buildSetMergingEnabledTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to provision over a record publishing different keys", async () => {
    const foreign = await honestRecord(true);
    fetchUserRecord.mockResolvedValue({
      ...foreign,
      nullifierPublicKey: new Uint8Array(32).fill(9),
    });

    const wiring = deps();
    const error = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER }).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("conflict");
    expect((error as HeliusRingsError).message).toContain("nullifier key");
    // The point of failing closed: nothing was sent, so the existing identity
    // is left exactly as it was for a human to look at.
    expect(buildRegistrationTransaction).not.toHaveBeenCalled();
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
  });

  it("does not report success when the record is still not merging after confirmation", async () => {
    buildRegistrationTransaction.mockResolvedValue({ kind: "registration" });
    fetchUserRecord
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(await honestRecord(false));

    const error = await provisionRingsIdentity(deps(), { walletId: "hrw_1", owner: OWNER }).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).message).toContain("merging is still disabled");
  });

  it("waits for confirmation before reading the record back", async () => {
    buildRegistrationTransaction.mockResolvedValue({ kind: "registration" });

    const order: string[] = [];
    const confirmTransaction = vi.fn(async () => {
      order.push("confirm");
      return 1n;
    });
    fetchUserRecord.mockImplementation(async () => {
      order.push("fetch");
      return order.filter((step) => step === "fetch").length === 1
        ? undefined
        : await honestRecord(true);
    });

    await provisionRingsIdentity(deps({ client: { confirmTransaction } as never }), {
      walletId: "hrw_1",
      owner: OWNER,
    });

    // A verification read issued before the writes confirmed could see
    // pre-registration state and reject a provision that in fact succeeded.
    expect(order.at(-1)).toBe("fetch");
    expect(order.at(-2)).toBe("confirm");
  });
});
