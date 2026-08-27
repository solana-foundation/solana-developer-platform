import { HeliusRingsError } from "@sdp/helius-rings";
import type { Transaction } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compiledRegistryTransaction,
  derivedIdentity,
  honestRecord,
  TEST_OWNER,
  TEST_SEED,
  unsignedTxBase64,
} from "./test/shielded-identity-fixtures.js";

const buildRegistrationTransaction = vi.fn();
const fetchUserRecord = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildRegistrationTransaction: (...args: unknown[]) => buildRegistrationTransaction(...args),
  fetchUserRecord: (...args: unknown[]) => fetchUserRecord(...args),
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { provisionRingsIdentity } = await import("./provision.js");

const OWNER = TEST_OWNER;

/** How the user-registry program numbers its three instructions. */
const REGISTER = 0;
const SET_MERGING_ENABLED = 1;
const UPDATE_KEYS = 2;

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** A real compiled transaction, not a marker: provisioning decodes what it signs. */
const REGISTRATION = compiledRegistryTransaction(OWNER, [REGISTER]);

function deps(overrides: Partial<Parameters<typeof provisionRingsIdentity>[0]> = {}) {
  return {
    client: { confirmTransaction: vi.fn().mockResolvedValue(1n) } as never,
    material: createDeterministicMaterialSource({ seed: TEST_SEED }),
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
    buildRegistrationTransaction.mockResolvedValue(REGISTRATION);
    fetchUserRecord.mockResolvedValueOnce(undefined).mockResolvedValueOnce(await honestRecord());

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result).toEqual({
      shieldedAddress: await derivedIdentity(),
      materialTag: "live",
    });
    // Custody signs only registration; merging is never provisioned.
    expect(buildRegistrationTransaction).toHaveBeenCalledTimes(1);
    expect(wiring.signTransaction).toHaveBeenCalledTimes(1);
    expect(wiring.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("hands the unsigned transaction to custody with the owner that must sign it", async () => {
    buildRegistrationTransaction.mockResolvedValue(REGISTRATION);
    fetchUserRecord.mockResolvedValueOnce(undefined).mockResolvedValueOnce(await honestRecord());

    const wiring = deps();
    await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    // The builder's bytes unaltered, plus the key custody has to be told to use.
    const unsigned = unsignedTxBase64(REGISTRATION);
    expect(wiring.signTransaction).toHaveBeenCalledWith(unsigned, OWNER);
    expect(wiring.submitTransaction).toHaveBeenCalledWith(`signed:${unsigned}`);
  });

  it("sends nothing when the identity is already registered", async () => {
    fetchUserRecord.mockResolvedValue(await honestRecord());

    const wiring = deps();
    const result = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER });

    expect(result.shieldedAddress).toBe(await derivedIdentity());
    expect(buildRegistrationTransaction).not.toHaveBeenCalled();
    expect(wiring.signTransaction).not.toHaveBeenCalled();
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["nullifier key", { nullifierPublicKey: new Uint8Array(32).fill(9) }],
    ["viewing key", { viewingPublicKey: new Uint8Array(33).fill(9) }],
  ])("refuses to provision over a record publishing a different %s", async (label, foreign) => {
    fetchUserRecord.mockResolvedValue({
      ...(await honestRecord({ mergingEnabled: true })),
      ...foreign,
    });

    const wiring = deps();
    const error = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER }).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("conflict");
    expect((error as HeliusRingsError).message).toContain(label);
    // The point of failing closed: nothing was sent, so the existing identity is
    // left exactly as it was for a human to look at.
    expect(buildRegistrationTransaction).not.toHaveBeenCalled();
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
  });

  it("reports the gateway unavailable when the record is absent after registering", async () => {
    buildRegistrationTransaction.mockResolvedValue(REGISTRATION);
    fetchUserRecord.mockResolvedValue(undefined);

    const error = await provisionRingsIdentity(deps(), {
      walletId: "hrw_1",
      owner: OWNER,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("gateway_unavailable");
  });

  it("waits for confirmation before reading the record back", async () => {
    buildRegistrationTransaction.mockResolvedValue(REGISTRATION);

    const order: string[] = [];
    const confirmTransaction = vi.fn(async () => {
      order.push("confirm");
      return 1n;
    });
    fetchUserRecord.mockImplementation(async () => {
      order.push("fetch");
      return order.filter((step) => step === "fetch").length === 1
        ? undefined
        : await honestRecord();
    });

    await provisionRingsIdentity(deps({ client: { confirmTransaction } as never }), {
      walletId: "hrw_1",
      owner: OWNER,
    });

    // A read issued before the write confirmed could see pre-registration state
    // and reject a provision that in fact succeeded.
    expect(order.at(-1)).toBe("fetch");
    expect(order.at(-2)).toBe("confirm");
  });

  it.each<[string, Transaction]>([
    ["update_keys", compiledRegistryTransaction(OWNER, [UPDATE_KEYS])],
    ["set_merging_enabled", compiledRegistryTransaction(OWNER, [SET_MERGING_ENABLED])],
    [
      "register against another program",
      compiledRegistryTransaction(OWNER, [REGISTER], SYSTEM_PROGRAM),
    ],
    ["more than one instruction", compiledRegistryTransaction(OWNER, [REGISTER, REGISTER])],
    ["an instruction with no data", compiledRegistryTransaction(OWNER, [undefined])],
  ])("refuses to sign %s", async (_label, built) => {
    // No record, so the control-flow guard waves this through and the builder is
    // reached: what refuses these is the decode of the bytes, on its own.
    buildRegistrationTransaction.mockResolvedValue(built);
    fetchUserRecord.mockResolvedValue(undefined);

    const wiring = deps();
    const error = await provisionRingsIdentity(wiring, { walletId: "hrw_1", owner: OWNER }).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect((error as HeliusRingsError).code).toBe("conflict");
    expect((error as HeliusRingsError).message).toContain(OWNER);
    // Nothing reached custody, so nothing could have been broadcast.
    expect(wiring.signTransaction).not.toHaveBeenCalled();
    expect(wiring.submitTransaction).not.toHaveBeenCalled();
  });
});
