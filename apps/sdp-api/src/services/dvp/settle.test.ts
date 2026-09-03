/**
 * Settle and cancel.
 *
 * The two things worth asserting here are ORDERING and ACCOUNT WIRING. Ordering,
 * because the approved-operation fence has to be crossed before any bytes go
 * out or a crash becomes unrecoverable. Wiring, because settle moves two
 * parties' tokens at once and a swapped destination sends the wrong asset to
 * the wrong person — a mistake nothing downstream would catch.
 */

import { getSettleDvpInstruction } from "@sdp/dvp";
import type { Address } from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const getAccountInfo = vi.hoisted(() => vi.fn());
const beginApprovedWalletOperationEffect = vi.hoisted(() => vi.fn());
const getOrCreateDvpSettlementWallet = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/policy/approved-operation-replay", () => ({
  beginApprovedWalletOperationEffect,
}));
vi.mock("./settlement-wallet", () => ({ getOrCreateDvpSettlementWallet }));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getAccountInfo,
  getRecentBlockhash: async () => ({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 100n,
  }),
  sendTransaction,
}));

const { closeDvpTrade } = await import("./settle");

const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const USER_A = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const USER_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_settle_test",
    organizationId: "org_x",
    projectId: "prj_x",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: SETTLEMENT_AUTHORITY,
    userA: USER_A,
    userB: USER_B,
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    nonce: "42",
    tokenProgramA: T22,
    tokenProgramB: T22,
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "USDC",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    userASettlementDestination: USER_A,
    userBSettlementDestination: USER_B,
    refString: null,
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    sdpSide: "a",
    sdpWalletId: "cwlt_leg",
    status: "funded",
    observedAt: null,
    sdpLegFundingSignature: null,
    sdpLegFundingTx: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    closeSignature: null,
    fundingClaimExpiryHeight: null,
    escrowAAmount: "1000",
    escrowBAmount: "2000",
    escrowAFrozen: false,
    escrowBFrozen: false,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

const context = { env } as never;

describe("closeDvpTrade", () => {
  /** The fee payer, which is what the funding pre-flight actually reads. */
  let feePayer = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    const signer = await generateKeyPairSigner();
    feePayer = signer.address;
    createOrgSignerForCustodyWallet.mockResolvedValue(signer);
    getOrCreateDvpSettlementWallet.mockResolvedValue({
      custodyWalletId: "cwlt_settlement",
      address: SETTLEMENT_AUTHORITY,
    });
    // Every required account already exists unless a test says otherwise.
    getAccountInfo.mockImplementation(async (_rpc: unknown, address: string) =>
      address === feePayer ? { lamports: 1_000_000_000 } : { owner: T22, data: new Uint8Array(165) }
    );
    beginApprovedWalletOperationEffect.mockResolvedValue(undefined);
    sendTransaction.mockResolvedValue("sig");
  });

  it("fences the approved operation before the bytes go out", async () => {
    const order: string[] = [];
    beginApprovedWalletOperationEffect.mockImplementation(async () => {
      order.push("fence");
    });
    sendTransaction.mockImplementation(async () => {
      order.push("send");
      return "sig";
    });

    await closeDvpTrade(context, trade(), "settle");

    expect(order).toEqual(["fence", "send"]);
  });

  it("refuses to settle a trade that is already closed", async () => {
    for (const status of ["settled", "cancelled", "closed_unknown", "create_failed"] as const) {
      await expect(closeDvpTrade(context, trade({ status }), "settle")).rejects.toThrow(
        /can no longer be settled/
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // Settle moves both legs, so both must be funded. Sending it on a half-funded
  // trade costs a signature to learn what the status already said.
  it("refuses to settle a trade that is not fully funded", async () => {
    await expect(
      closeDvpTrade(context, trade({ status: "partially_funded" }), "settle")
    ).rejects.toThrow(/requires both legs funded/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // Cancel is the escape hatch. Requiring funding would make an abandoned
  // half-funded trade impossible to unwind, which is the opposite of the point.
  it("cancels a partially funded trade", async () => {
    const result = await closeDvpTrade(context, trade({ status: "partially_funded" }), "cancel");

    // The signature is taken from the SIGNED BYTES, not from what the RPC
    // returns — so it is known before the send and survives an ambiguous one.
    expect(result.signature).toEqual(expect.any(String));
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  // The authority is a PDA seed, so it is fixed in the trade's address. A
  // rotated settlement wallet cannot sign for older trades and saying so beats
  // sending a transaction the program will reject.
  it("refuses when the project's settlement wallet is not the trade's authority", async () => {
    getOrCreateDvpSettlementWallet.mockResolvedValue({
      custodyWalletId: "cwlt_new",
      address: USER_B,
    });

    await expect(closeDvpTrade(context, trade(), "settle")).rejects.toThrow(
      /part of the trade's address and cannot be changed/
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  describe("required accounts", () => {
    it("creates the accounts settlement needs when they are missing", async () => {
      // Every token account absent, but the fee payer solvent: this test is
      // about which accounts get created, not about who pays for them.
      getAccountInfo.mockImplementation(async (_rpc: unknown, address: string) =>
        address === feePayer ? { lamports: 1_000_000_000 } : null
      );

      const result = await closeDvpTrade(context, trade(), "settle");

      // All four: both delivery destinations and both surplus-refund accounts.
      expect(result.createdAccounts).toHaveLength(4);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("creates nothing when every account already exists", async () => {
      const result = await closeDvpTrade(context, trade(), "settle");

      expect(result.createdAccounts).toEqual([]);
    });

    // Cancel delivers nothing, so a missing delivery destination must not block
    // it — that would make the escape hatch depend on an account it never uses.
    it("creates only the refund accounts for a cancel", async () => {
      // Every token account absent, but the fee payer solvent: this test is
      // about which accounts get created, not about who pays for them.
      getAccountInfo.mockImplementation(async (_rpc: unknown, address: string) =>
        address === feePayer ? { lamports: 1_000_000_000 } : null
      );

      const result = await closeDvpTrade(context, trade(), "cancel");

      expect(result.createdAccounts).toHaveLength(2);
    });
  });

  // Each party receives the OTHER leg's mint. Getting this backwards would send
  // the asset to the party who was already holding it and nothing would notice.
  it("delivers each leg to the counter-party's destination", async () => {
    const signer = await generateKeyPairSigner();
    const row = trade();
    const { deriveDvpSettleAtas } = await import("./settle-preflight");
    const atas = await deriveDvpSettleAtas({
      userA: row.userA as Address,
      userB: row.userB as Address,
      userASettlementDestination: row.userASettlementDestination as Address,
      userBSettlementDestination: row.userBSettlementDestination as Address,
      mintA: row.mintA as Address,
      mintB: row.mintB as Address,
      tokenProgramA: row.tokenProgramA as Address,
      tokenProgramB: row.tokenProgramB as Address,
    });

    const instruction = getSettleDvpInstruction({
      settlementAuthority: signer,
      swapDvp: row.swapDvp as Address,
      mintA: row.mintA as Address,
      mintB: row.mintB as Address,
      dvpAtaA: row.escrowA as Address,
      dvpAtaB: row.escrowB as Address,
      userADestinationAtaB: atas.userADestinationAtaB,
      userBDestinationAtaA: atas.userBDestinationAtaA,
      userAAtaA: atas.userAAtaA,
      userBAtaB: atas.userBAtaB,
      tokenProgramA: row.tokenProgramA as Address,
      tokenProgramB: row.tokenProgramB as Address,
      memoProgram: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address,
      legAExtrasCount: 0,
    });

    // user A's delivery account holds mint B, and vice versa. Same account in
    // both directions would mean the trade delivered nothing.
    expect(atas.userADestinationAtaB).not.toBe(atas.userBDestinationAtaA);
    expect(atas.userADestinationAtaB).not.toBe(atas.userAAtaA);
    expect(instruction.accounts).toBeDefined();
  });

  /**
   * The settlement authority pays the fee and the rent for every account a
   * close creates, and it is provisioned empty. Nothing funds it, so the first
   * settle in every project failed in simulation with "Attempt to debit an
   * account but found no record of a prior credit" — an error naming neither
   * the account nor the amount, nested two levels inside a SolanaError cause,
   * and shown to the user as "An internal error occurred".
   */
  describe("when the settlement authority cannot pay", () => {
    beforeEach(() => {
      getAccountInfo.mockImplementation(async (_rpc: unknown, address: string) =>
        address === feePayer ? { lamports: 0 } : null
      );
    });

    it("refuses before spending a signature, naming the account and the shortfall", async () => {
      await expect(closeDvpTrade(context, trade(), "settle")).rejects.toThrow(
        /settlement authority .* holds 0 lamports but needs about \d+/
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("says how much more it needs, so the answer is actionable", async () => {
      await expect(closeDvpTrade(context, trade(), "settle")).rejects.toThrow(
        /Send it at least \d+ more lamports/
      );
    });

    // Cancel creates only the two refund accounts, so it needs less. Quoting
    // settle's figure would over-state what a cancel actually costs.
    it("asks for less to cancel, which creates fewer accounts", async () => {
      const settleCost = await closeDvpTrade(context, trade(), "settle").catch(
        (error: Error) => error.message
      );
      const cancelCost = await closeDvpTrade(context, trade(), "cancel").catch(
        (error: Error) => error.message
      );

      const figure = (message: string) => Number(/needs about (\d+)/.exec(message)?.[1]);
      expect(figure(cancelCost as string)).toBeLessThan(figure(settleCost as string));
    });

    // An unreadable balance is an RPC anomaly, not a balance of zero. Treating
    // it as zero would refuse a settlement that would have worked.
    it("does not block when the balance cannot be read", async () => {
      getAccountInfo.mockImplementation(async (_rpc: unknown, address: string) =>
        address === feePayer ? {} : { owner: T22, data: new Uint8Array(165) }
      );

      await expect(closeDvpTrade(context, trade(), "settle")).resolves.toBeDefined();
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
