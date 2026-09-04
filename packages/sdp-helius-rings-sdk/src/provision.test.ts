import { HeliusRingsError } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildRegistrationTransaction = vi.fn();
const fetchUserRecord = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildRegistrationTransaction: (...args: unknown[]) => buildRegistrationTransaction(...args),
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
  });

  it("registers and verifies the record without enabling merging", async () => {
    buildRegistrationTransaction.mockResolvedValue({ kind: "registration" });
    fetchUserRecord
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(await honestRecord(false));

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result.registrationSignatures).toHaveLength(1);
    expect(result.mergingEnabled).toBe(false);
    expect(result.materialTag).toBe("live");
    expect(result.identity.owner).toBe(OWNER);
    // Custody signs only registration; product-disabled merge is not provisioned.
    expect(wiring.signTransaction).toHaveBeenCalledTimes(1);
    expect(wiring.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the identity is already registered with merging disabled", async () => {
    const record = await honestRecord(false);
    fetchUserRecord.mockResolvedValue(record);

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result.registrationSignatures).toEqual([]);
    expect(result.mergingEnabled).toBe(false);
    expect(buildRegistrationTransaction).not.toHaveBeenCalled();
    expect(wiring.signTransaction).not.toHaveBeenCalled();
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
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
        : await honestRecord(false);
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
