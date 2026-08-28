import { HeliusRingsError } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_NATIVE_MINT, SDP_NATIVE_MINT } from "./flows/mint.js";
import {
  compiledRegistryTransaction,
  derivedIdentity,
  TEST_OWNER,
  TEST_REQUEST,
  TEST_SEED,
  unsignedTxBase64,
} from "./test/shielded-identity-fixtures.js";

const buildDepositTransaction = vi.fn();
const buildRingDepositTransaction = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildDepositTransaction: (...args: unknown[]) => buildDepositTransaction(...args),
}));

vi.mock("@heliuslabs/zolana/ring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/ring")>()),
  buildRingDepositTransaction: (...args: unknown[]) => buildRingDepositTransaction(...args),
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { buildShieldTransaction } = await import("./shield.js");

const OWNER = TEST_OWNER;
const REQUEST = TEST_REQUEST;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// Distinct from TEST_OWNER so a swapped parameter cannot pass.
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";

const BUILT = compiledRegistryTransaction(OWNER, [0]);

function deps(overrides?: { ringProgramId?: string }) {
  return {
    client: {} as never,
    material: createDeterministicMaterialSource({ seed: TEST_SEED }),
    organizationId: REQUEST.organizationId,
    projectId: REQUEST.projectId,
    ...overrides,
  };
}

describe("buildShieldTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDepositTransaction.mockResolvedValue(BUILT);
    buildRingDepositTransaction.mockResolvedValue(BUILT);
  });

  it("binds the deposit to the configured ring instead of the default pool", async () => {
    const expected = await derivedIdentity();
    const encoded = await buildShieldTransaction(deps({ ringProgramId: RING_PROGRAM }), {
      walletId: REQUEST.walletId,
      owner: OWNER,
      mint: SDP_NATIVE_MINT,
      amountRaw: "1000000000",
      expectedShieldedAddress: expected,
    });

    // The default builder would create a note the ring's transact cannot spend.
    expect(buildDepositTransaction).not.toHaveBeenCalled();
    expect(encoded).toBe(unsignedTxBase64(BUILT));
    const params = buildRingDepositTransaction.mock.calls[0]?.[0] as {
      ringProgramId: string;
      feePayer: string;
      depositor: string;
      amount: bigint;
    };
    expect(params.ringProgramId).toBe(RING_PROGRAM);
    expect(params.feePayer).toBe(OWNER);
    expect(params.depositor).toBe(OWNER);
    expect(params.amount).toBe(1_000_000_000n);
  });

  it("classifies an invalid configured ring without exposing its value", async () => {
    const configuredRing = "not-a-solana-address";
    const error = await buildShieldTransaction(deps({ ringProgramId: configuredRing }), {
      walletId: REQUEST.walletId,
      owner: OWNER,
      mint: SDP_NATIVE_MINT,
      amountRaw: "1",
      expectedShieldedAddress: await derivedIdentity(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(HeliusRingsError);
    expect(error).toMatchObject({ code: "config_error" });
    expect((error as Error).message).not.toContain(configuredRing);
    expect(buildDepositTransaction).not.toHaveBeenCalled();
    expect(buildRingDepositTransaction).not.toHaveBeenCalled();
  });

  it("deposits to the derived identity, converting SDP's native mint", async () => {
    const expected = await derivedIdentity();
    const encoded = await buildShieldTransaction(deps(), {
      walletId: REQUEST.walletId,
      owner: OWNER,
      mint: SDP_NATIVE_MINT,
      amountRaw: "1000000000",
      expectedShieldedAddress: expected,
    });

    expect(encoded).toBe(unsignedTxBase64(BUILT));
    expect(buildDepositTransaction).toHaveBeenCalledTimes(1);
    const params = buildDepositTransaction.mock.calls[0]?.[0] as {
      feePayer: string;
      depositor: string;
      recipient: { constructor: { name: string } };
      asset: string;
      amount: bigint;
    };
    expect(params.feePayer).toBe(OWNER);
    expect(params.depositor).toBe(OWNER);
    expect(params.asset).toBe(PROTOCOL_NATIVE_MINT);
    expect(params.amount).toBe(1_000_000_000n);
    expect(params.recipient).toBeDefined();
  });

  it("passes a non-native mint through unchanged", async () => {
    const expected = await derivedIdentity();
    await buildShieldTransaction(deps(), {
      walletId: REQUEST.walletId,
      owner: OWNER,
      mint: USDC,
      amountRaw: "1500000",
      expectedShieldedAddress: expected,
    });

    const params = buildDepositTransaction.mock.calls[0]?.[0] as { asset: string; amount: bigint };
    expect(params.asset).toBe(USDC);
    expect(params.amount).toBe(1_500_000n);
  });

  it("refuses a wallet whose derived identity is not the one provisioning stored", async () => {
    const foreign = await derivedIdentity({ ...REQUEST, walletId: "hrw_other" });

    await expect(
      buildShieldTransaction(deps(), {
        walletId: REQUEST.walletId,
        owner: OWNER,
        mint: SDP_NATIVE_MINT,
        amountRaw: "1",
        expectedShieldedAddress: foreign,
      })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(buildDepositTransaction).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "", "1.5", "-1"])("refuses amount %j", async (amountRaw) => {
    const expected = await derivedIdentity();
    await expect(
      buildShieldTransaction(deps(), {
        walletId: REQUEST.walletId,
        owner: OWNER,
        mint: SDP_NATIVE_MINT,
        amountRaw,
        expectedShieldedAddress: expected,
      })
    ).rejects.toBeInstanceOf(HeliusRingsError);
    expect(buildDepositTransaction).not.toHaveBeenCalled();
  });

  it("refuses an amount that does not fit uint64", async () => {
    const expected = await derivedIdentity();
    await expect(
      buildShieldTransaction(deps(), {
        walletId: REQUEST.walletId,
        owner: OWNER,
        mint: SDP_NATIVE_MINT,
        amountRaw: "18446744073709551616",
        expectedShieldedAddress: expected,
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
