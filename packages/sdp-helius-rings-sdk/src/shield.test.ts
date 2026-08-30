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

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildDepositTransaction: (...args: unknown[]) => buildDepositTransaction(...args),
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { buildShieldTransaction } = await import("./shield.js");

const OWNER = TEST_OWNER;
const REQUEST = TEST_REQUEST;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const BUILT = compiledRegistryTransaction(OWNER, [0]);

function deps() {
  return {
    client: {} as never,
    material: createDeterministicMaterialSource({ seed: TEST_SEED }),
    organizationId: REQUEST.organizationId,
    projectId: REQUEST.projectId,
  };
}

describe("buildShieldTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDepositTransaction.mockResolvedValue(BUILT);
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
