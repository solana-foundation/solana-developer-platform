/**
 * Funding SDP's leg.
 *
 * The transfer itself is unremarkable. Every test here is about a REFUSAL,
 * because each one prevents a state the trade cannot recover from: an
 * over-funded escrow puts settlement at risk, and a frozen escrow silently
 * eats the attempt.
 */

import { generateKeyPairSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const beginApprovedWalletOperationEffect = vi.hoisted(() => vi.fn());
const readEscrowState = vi.hoisted(() => vi.fn());
const readMintDecimals = vi.hoisted(() => vi.fn());
const claimLegFunding = vi.hoisted(() => vi.fn());
const releaseLegFunding = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/policy/approved-operation-replay", () => ({
  beginApprovedWalletOperationEffect,
}));
vi.mock("./read-chain", () => ({ readEscrowState }));
vi.mock("@/db/repositories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/repositories")>()),
  createDvpTradeRepository: () => ({ claimLegFunding, releaseLegFunding }),
}));
vi.mock("./mints", () => ({ readMintDecimals }));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getRecentBlockhash: async () => ({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 100n,
  }),
  sendTransaction,
}));

const { fundDvpTradeLeg } = await import("./fund");

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_fund_test",
    organizationId: "org_x",
    projectId: "prj_x",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    userA: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userB: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    nonce: "42",
    tokenProgramA: T22,
    tokenProgramB: T22,
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userBSettlementDestination: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    refString: null,
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    sdpSide: "a",
    sdpWalletId: "cwlt_leg",
    status: "created",
    observedAt: null,
    sdpLegFundingSignature: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

const context = { env } as never;

describe("fundDvpTradeLeg", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createOrgSignerForCustodyWallet.mockResolvedValue(await generateKeyPairSigner());
    readEscrowState.mockResolvedValue({ amount: 0n, frozen: false });
    readMintDecimals.mockResolvedValue(6);
    beginApprovedWalletOperationEffect.mockResolvedValue(undefined);
    sendTransaction.mockResolvedValue("sig");
    claimLegFunding.mockResolvedValue(true);
    releaseLegFunding.mockResolvedValue(undefined);
  });

  it("moves SDP's leg into its escrow", async () => {
    const result = await fundDvpTradeLeg(context, trade());

    expect(result.leg).toBe("a");
    // The trade's amount, never a caller's number.
    expect(result.amount).toBe("1000");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("funds leg B when that is the side SDP holds", async () => {
    const result = await fundDvpTradeLeg(context, trade({ sdpSide: "b" }));

    expect(result.leg).toBe("b");
    expect(result.amount).toBe("2000");
  });

  it("fences the approved operation before the bytes go out", async () => {
    const order: string[] = [];
    beginApprovedWalletOperationEffect.mockImplementation(async () => void order.push("fence"));
    sendTransaction.mockImplementation(async () => {
      order.push("send");
      return "sig";
    });

    await fundDvpTradeLeg(context, trade());

    expect(order).toEqual(["fence", "send"]);
  });

  // Calling twice would OVER-fund, and a surplus is not harmless: settle
  // refunds it, and on a transfer-hook mint that refund can revert the whole
  // settlement. This endpoint must not manufacture the hazard the trade page
  // exists to warn about.
  it("refuses a leg that already holds its target", async () => {
    readEscrowState.mockResolvedValue({ amount: 1000n, frozen: false });

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow(/nothing left to fund/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a leg already holding more than its target", async () => {
    readEscrowState.mockResolvedValue({ amount: 5000n, frozen: false });

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow(/nothing left to fund/);
  });

  // Topping up must send the SHORTFALL. Sending the full target on top of a
  // partial deposit leaves a surplus, and settlement refunds a surplus, which
  // on a transfer-hook mint can revert the whole settlement.
  it("tops a partly funded leg up by the shortfall, not the full target", async () => {
    readEscrowState.mockResolvedValue({ amount: 400n, frozen: false });

    const result = await fundDvpTradeLeg(context, trade());

    expect(result.amount).toBe("600");
  });

  // The transfer would bounce. Learning that from a failed broadcast costs a
  // signature and surfaces as an unexplained failure.
  it("refuses a frozen escrow, and says why", async () => {
    readEscrowState.mockResolvedValue({ amount: 0n, frozen: true });

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow(/frozen/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("funds an escrow that does not exist yet", async () => {
    readEscrowState.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade())).resolves.toMatchObject({ amount: "1000" });
  });

  it("refuses a trade that can no longer be funded", async () => {
    for (const status of ["settled", "cancelled", "closed_unknown", "create_failed"] as const) {
      await expect(fundDvpTradeLeg(context, trade({ status }))).rejects.toThrow(
        /can no longer be funded/
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // The balance read and the transfer are not atomic, so the claim is what
  // makes exactly one of two overlapping requests broadcast.
  it("refuses to broadcast when another request holds the funding claim", async () => {
    claimLegFunding.mockResolvedValue(false);

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow(/already being funded/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("claims before it broadcasts", async () => {
    const order: string[] = [];
    claimLegFunding.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    sendTransaction.mockImplementation(async () => {
      order.push("send");
      return "sig";
    });

    await fundDvpTradeLeg(context, trade());

    expect(order).toEqual(["claim", "send"]);
  });

  // An ambiguous send may still land, so releasing the claim would invite a
  // second transfer on top of the first.
  it("keeps the claim when a send fails ambiguously", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow("socket hang up");
    expect(releaseLegFunding).not.toHaveBeenCalled();
  });

  it("refuses when the mint cannot be read", async () => {
    readMintDecimals.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade())).rejects.toThrow(/could not be read/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
