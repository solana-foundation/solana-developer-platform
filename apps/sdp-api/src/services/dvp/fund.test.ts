/**
 * Funding one side of a trade.
 *
 * The transfer itself is unremarkable. Every test here is about a REFUSAL,
 * because each one prevents a state the trade cannot recover from: an
 * over-funded escrow puts settlement at risk, and a frozen escrow silently
 * eats the attempt.
 *
 * One suite for every funder now: creator and party funding are the same
 * operation, so the claim always lands on `dvp_leg_funding_claims`, keyed
 * (trade, side) and owned by the organization whose wallet authorizes it.
 */

import { SwapDvpVerificationError } from "@sdp/dvp";
import { DVP_LEG_REFUSAL } from "@sdp/types";
import {
  getSignatureFromTransaction,
  getTransactionDecoder,
  none,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  some,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { type AppError, conflict } from "@/lib/errors";
import {
  acceptTransaction,
  buildDvpTradeRow,
  createTestSponsor,
  DVP_TEST_T22,
} from "@/test/fixtures/dvp";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const readEscrowState = vi.hoisted(() => vi.fn());
const readDvpAccounts = vi.hoisted(() => vi.fn());
const verifySwapDvpAccount = vi.hoisted(() => vi.fn());
const decodeSwapDvpChecked = vi.hoisted(() => vi.fn());
const readMintDecimals = vi.hoisted(() => vi.fn());
const claimFunding = vi.hoisted(() => vi.fn());
const releaseFunding = vi.hoisted(() => vi.fn());
const recordFundingTx = vi.hoisted(() => vi.fn());
const rebindSignature = vi.hoisted(() => vi.fn());
const hasClaim = vi.hoisted(() => vi.fn());
const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());
const prepareOwnedSubmission = vi.hoisted(() => vi.fn());
const fetchMaybeToken = vi.hoisted(() => vi.fn());

let sponsor: Awaited<ReturnType<typeof createTestSponsor>>;

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createProjectSponsorshipFeePayment,
}));
vi.mock("./read-chain", () => ({ readEscrowState, readDvpAccounts }));
vi.mock("@sdp/dvp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/dvp")>()),
  verifySwapDvpAccount,
  decodeSwapDvpChecked,
}));
const assertTradeNotClosing = vi.hoisted(() => vi.fn());
vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("./close-exclusion", () => ({ assertTradeNotClosing }));
vi.mock("@/db/repositories/dvp-leg-funding-claim.repository", () => ({
  createPostgresDvpLegFundingClaimRepository: () => ({
    claim: claimFunding,
    release: releaseFunding,
    rebindSignature,
    hasClaim,
    recordFundingTx,
  }),
}));
vi.mock("./mints", () => ({ readMintDecimals }));
vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMaybeToken,
}));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getRecentBlockhash: async () => ({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 100n,
  }),
  sendTransaction,
}));

const { fundDvpTradeLeg } = await import("./fund");

const _T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return buildDvpTradeRow({ id: "dvp_fund_test", ...overrides });
}

/** The funder: whoever's custody wallet holds the side's party address. */
const recordAttempt = vi.hoisted(() => vi.fn());

const FUNDER_A = {
  side: "a" as const,
  custodyWalletId: "cwlt_a",
  organizationId: "org_x",
  projectId: "prj_x",
  recordAttempt,
};

const context = { env } as never;

describe("fundDvpTradeLeg", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sponsor = await createTestSponsor();
    createOrgSignerForCustodyWallet.mockResolvedValue(await generateKeyPairSigner());
    readEscrowState.mockResolvedValue({ amount: 0n, frozen: false });
    readDvpAccounts.mockImplementation(async () => {
      const state = await readEscrowState();
      const leg =
        state === null
          ? { exists: false, tampered: false }
          : { exists: true, amount: state.amount, frozen: state.frozen };
      return { trade: { address: trade().swapDvp, exists: true }, legA: leg, legB: leg };
    });
    verifySwapDvpAccount.mockResolvedValue({ address: trade().swapDvp });
    decodeSwapDvpChecked.mockImplementation(() => ({
      data: {
        userA: trade().userA,
        userB: trade().userB,
        mintA: trade().mintA,
        mintB: trade().mintB,
        amountA: BigInt(trade().amountA),
        amountB: BigInt(trade().amountB),
        expiryTimestamp: BigInt(trade().expiryTimestamp),
        userASettlementDestination: trade().userASettlementDestination,
        userBSettlementDestination: trade().userBSettlementDestination,
        settlementAuthority: trade().settlementAuthority,
        nonce: BigInt(trade().nonce),
        earliestSettlementTimestamp: none(),
      },
    }));
    readMintDecimals.mockResolvedValue(6);
    fetchMaybeToken.mockResolvedValue({ exists: true, data: { amount: 10_000n } });
    prepareOwnedSubmission.mockImplementation(sponsor.prepareOwnedSubmission);
    createProjectSponsorshipFeePayment.mockResolvedValue({
      getFeePayer: async () => sponsor.address,
      prepareOwnedSubmission,
    });
    sendTransaction.mockImplementation(acceptTransaction);
    claimFunding.mockResolvedValue(true);
    assertTradeNotClosing.mockResolvedValue(undefined);
    releaseFunding.mockResolvedValue(undefined);
    rebindSignature.mockResolvedValue(true);
    hasClaim.mockResolvedValue(true);
    recordFundingTx.mockResolvedValue(undefined);
  });

  it("moves the named side's leg into its escrow", async () => {
    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(result.leg).toBe("a");
    // The trade's amount, never a caller's number.
    expect(result.amount).toBe("1000");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  // A retry with the same key has to be able to ask the chain what this send
  // did, so the transaction is on the idempotency record before it goes out.
  it("records the signed transfer for its idempotency key before broadcasting it", async () => {
    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(recordAttempt).toHaveBeenCalledWith({
      signature: result.signature,
      amount: "1000",
      expiryHeight: "100",
    });
    expect(recordAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      sendTransaction.mock.invocationCallOrder[0]
    );
  });

  it("funds leg B when that is the side named", async () => {
    const result = await fundDvpTradeLeg(context, trade(), {
      side: "b",
      custodyWalletId: "cwlt_b",
      organizationId: "org_x",
      projectId: "prj_x",
      recordAttempt,
    });

    expect(result.leg).toBe("b");
    expect(result.amount).toBe("2000");
  });

  // Calling twice would OVER-fund, and a surplus is not harmless: settle
  // refunds it, and on a transfer-hook mint that refund can revert the whole
  // settlement. This endpoint must not manufacture the hazard the trade page
  // exists to warn about.
  // The claim is a lock with a deliberately short life: it is released on a
  // rejected broadcast and swept once its blockhash expires, so a leg that
  // funded correctly ends up holding none.
  it("records the funding transaction separately from the claim", async () => {
    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(recordFundingTx).toHaveBeenCalledWith(trade().id, "a", result.signature);
  });

  it("records no receipt when the send failed", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow("socket hang up");
    expect(recordFundingTx).not.toHaveBeenCalled();
  });

  it("refuses a leg that already holds its target", async () => {
    readEscrowState.mockResolvedValue({ amount: 1000n, frozen: false });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/nothing left to fund/),
      details: { reason: DVP_LEG_REFUSAL.legAlreadyFunded },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a leg already holding more than its target", async () => {
    readEscrowState.mockResolvedValue({ amount: 5000n, frozen: false });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/nothing left to fund/),
      details: { reason: DVP_LEG_REFUSAL.legAlreadyFunded },
    });
  });

  // Topping up must send the SHORTFALL. Sending the full target on top of a
  // partial deposit leaves a surplus, and settlement refunds a surplus, which
  // on a transfer-hook mint can revert the whole settlement.
  it("tops a partly funded leg up by the shortfall, not the full target", async () => {
    readEscrowState.mockResolvedValue({ amount: 400n, frozen: false });

    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(result.amount).toBe("600");
  });

  // The transfer would bounce. Learning that from a failed broadcast costs a
  // signature and surfaces as an unexplained failure.
  it("refuses a frozen escrow, and says why", async () => {
    readEscrowState.mockResolvedValue({ amount: 0n, frozen: true });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/frozen/),
      details: { reason: DVP_LEG_REFUSAL.escrowFrozen },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a fundable leg whose escrow is missing", async () => {
    readEscrowState.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/escrow for this leg is missing; nothing was sent/),
      details: { reason: DVP_LEG_REFUSAL.escrowMissing },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("returns a conflict before claiming a tampered escrow", async () => {
    readDvpAccounts.mockResolvedValue({
      trade: { address: trade().swapDvp, exists: true },
      legA: { exists: false, tampered: true },
      legB: { exists: true, amount: 0n, frozen: false },
    });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(
        "the escrow for this leg is not the trade's token account (owner/mint/program mismatch); refusing to touch it"
      ),
      details: { reason: DVP_LEG_REFUSAL.escrowMismatch },
    });
    expect(claimFunding).not.toHaveBeenCalled();
  });

  it("refuses a trade that is no longer verifiable on chain", async () => {
    verifySwapDvpAccount.mockRejectedValue(
      new SwapDvpVerificationError("there is no SwapDvp at that address")
    );

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/trade is no longer on chain; nothing was sent/),
      details: { reason: DVP_LEG_REFUSAL.tradeNotOnChain },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the live trade terms do not match the recorded terms", async () => {
    decodeSwapDvpChecked.mockImplementation(() => ({
      data: {
        userA: trade().userA,
        userB: trade().userB,
        mintA: trade().mintA,
        mintB: trade().mintB,
        amountA: 9999n,
        amountB: BigInt(trade().amountB),
        expiryTimestamp: BigInt(trade().expiryTimestamp),
        userASettlementDestination: trade().userASettlementDestination,
        userBSettlementDestination: trade().userBSettlementDestination,
        settlementAuthority: trade().settlementAuthority,
        nonce: BigInt(trade().nonce),
        earliestSettlementTimestamp: none(),
      },
    }));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(
        /on-chain trade does not match the recorded terms; nothing was sent/
      ),
      details: { reason: DVP_LEG_REFUSAL.termsMismatch },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // Not a PDA seed either: a re-created trade can allow settlement earlier
  // than the recorded deal, and only the terms check would notice.
  it("refuses when the live trade carries an earliest settlement time the deal did not", async () => {
    decodeSwapDvpChecked.mockImplementation(() => ({
      data: {
        userA: trade().userA,
        userB: trade().userB,
        mintA: trade().mintA,
        mintB: trade().mintB,
        amountA: BigInt(trade().amountA),
        amountB: BigInt(trade().amountB),
        expiryTimestamp: BigInt(trade().expiryTimestamp),
        userASettlementDestination: trade().userASettlementDestination,
        userBSettlementDestination: trade().userBSettlementDestination,
        settlementAuthority: trade().settlementAuthority,
        nonce: BigInt(trade().nonce),
        earliestSettlementTimestamp: some(1n),
      },
    }));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(
        /on-chain trade does not match the recorded terms; nothing was sent/
      ),
      details: { reason: DVP_LEG_REFUSAL.termsMismatch },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a trade that can no longer be funded", async () => {
    for (const status of ["settled", "cancelled", "closed_unknown", "create_failed"] as const) {
      await expect(fundDvpTradeLeg(context, trade({ status }), FUNDER_A)).rejects.toMatchObject({
        message: expect.stringMatching(/can no longer be funded/),
        details: { reason: DVP_LEG_REFUSAL.tradeNotFundable },
      });
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // The balance read and the transfer are not atomic, so the claim is what
  // makes exactly one of two overlapping requests broadcast.
  it("refuses to broadcast when another request holds the funding claim", async () => {
    claimFunding.mockResolvedValue(false);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/already being funded/),
      details: { reason: DVP_LEG_REFUSAL.legFundingInProgress },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("claims before Kora signs and before it broadcasts", async () => {
    const order: string[] = [];
    claimFunding.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    prepareOwnedSubmission.mockImplementation(async (transaction, lifecycle) => {
      order.push("sponsor");
      return sponsor.prepareOwnedSubmission(transaction, lifecycle);
    });
    sendTransaction.mockImplementation(async () => {
      order.push("send");
      const signature = rebindSignature.mock.calls[0][3];
      return signature;
    });

    await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(order).toEqual(["claim", "sponsor", "send"]);
  });

  it("rebinds the claim to the sponsored signature before broadcast", async () => {
    const order: string[] = [];
    rebindSignature.mockImplementation(async () => {
      order.push("rebind");
      return true;
    });
    sendTransaction.mockImplementation(async (_rpc, bytes) => {
      order.push("send");
      return getSignatureFromTransaction(getTransactionDecoder().decode(bytes));
    });

    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);
    const claimSignature = claimFunding.mock.calls[0][0].signature;

    expect(rebindSignature).toHaveBeenCalledWith(trade().id, "a", claimSignature, result.signature);
    expect(order).toEqual(["rebind", "send"]);
  });

  it("releases the claim when sponsorship fails before signing", async () => {
    prepareOwnedSubmission.mockRejectedValue(new Error("Kora unavailable"));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow("Kora unavailable");

    const claimSignature = claimFunding.mock.calls[0][0].signature;
    expect(releaseFunding).toHaveBeenCalledWith(trade().id, "a", claimSignature);
    expect(rebindSignature).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // An ambiguous send may still land, so releasing the claim would invite a
  // second transfer on top of the first.
  it("keeps the claim when a send fails ambiguously", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow("socket hang up");
    expect(releaseFunding).not.toHaveBeenCalled();
    expect(rebindSignature).toHaveBeenCalledTimes(1);
  });

  it("refuses when the mint cannot be read", async () => {
    readMintDecimals.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/could not be read/),
      details: { reason: DVP_LEG_REFUSAL.mintUnreadable },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses before claiming when the funding wallet has no source token account", async () => {
    const signer = await generateKeyPairSigner();
    createOrgSignerForCustodyWallet.mockResolvedValue(signer);
    fetchMaybeToken.mockResolvedValue({ address: signer.address, exists: false });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: expect.stringContaining(signer.address),
      details: { reason: DVP_LEG_REFUSAL.walletHoldsNoToken },
    } satisfies Partial<AppError>);

    expect(claimFunding).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses before claiming when the source balance is below the shortfall", async () => {
    fetchMaybeToken.mockResolvedValue({ exists: true, data: { amount: 250n } });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: expect.stringMatching(/holds 0\.00025 of the 0\.001 /),
      details: { reason: DVP_LEG_REFUSAL.walletBalanceShort },
    } satisfies Partial<AppError>);

    expect(claimFunding).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("maps a preflight rejection and releases the funding claim", async () => {
    sendTransaction.mockRejectedValue(
      new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
        accounts: null,
        fee: null,
        loadedAccountsDataSize: null,
        loadedAddresses: null,
        logs: [
          "Program log: Instruction: TransferChecked",
          "Program log: Error: IncorrectProgramId",
          `Program ${DVP_TEST_T22} failed: incorrect program id for instruction`,
        ],
        postBalances: null,
        postTokenBalances: null,
        preBalances: null,
        preTokenBalances: null,
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: null,
      })
    );

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      statusCode: 400,
      message: expect.stringContaining("IncorrectProgramId"),
    } satisfies Partial<AppError>);
    expect(releaseFunding).toHaveBeenCalledTimes(1);
  });

  // The escrow ATA takes a transfer from ANYONE, and resolving a signer at the
  // custody provider sits between the first balance read and the broadcast. A
  // deposit landing in that window makes the computed shortfall too large, and
  // sending it anyway over-funds the escrow — the surplus then has to be
  // refunded at settlement, which a transfer-hook mint can reject outright.
  //
  // The claim does not cover this: it serialises OUR requests, not a stranger's
  // transfer. Only re-reading does.
  describe("a third-party deposit landing mid-flight", () => {
    it("aborts rather than over-funding, and sends nothing", async () => {
      readEscrowState
        .mockResolvedValueOnce({ amount: 0n, frozen: false })
        .mockResolvedValueOnce({ amount: 400n, frozen: false });

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toMatchObject({
        message: expect.stringMatching(/no longer the amount owed/),
        details: { reason: DVP_LEG_REFUSAL.escrowBalanceChanged },
      });
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    // Aborting has to be free. The re-read sits before the claim so a refusal
    // leaves no claim to release.
    it("does not take or release the funding claim", async () => {
      readEscrowState
        .mockResolvedValueOnce({ amount: 0n, frozen: false })
        .mockResolvedValueOnce({ amount: 400n, frozen: false });

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
        /no longer the amount owed/
      );

      expect(claimFunding).not.toHaveBeenCalled();
      expect(releaseFunding).not.toHaveBeenCalled();
    });

    it("still funds when the balance is unchanged by the second read", async () => {
      readEscrowState
        .mockResolvedValueOnce({ amount: 400n, frozen: false })
        .mockResolvedValueOnce({ amount: 400n, frozen: false });

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).resolves.toMatchObject({
        amount: "600",
      });
    });
  });

  // The lock is keyed (trade, side) and owned by the FUNDING organization, so
  // a party funding its own leg of somebody else's trade takes its own row
  // and never a cross-organization write.
  describe("the claim row", () => {
    it("is keyed by (trade, side) and owned by the funder", async () => {
      await fundDvpTradeLeg(context, trade(), FUNDER_A);

      expect(claimFunding).toHaveBeenCalledWith(
        expect.objectContaining({
          tradeId: "dvp_fund_test",
          side: "a",
          organizationId: "org_x",
          projectId: "prj_x",
          custodyWalletId: "cwlt_a",
          expiryHeight: "100",
        })
      );
    });

    // Cross-org: org B funds its own side of org A's trade. The claim row
    // carries org B's ids — not the creating org's — which is what keeps the
    // write inside ordinary tenant isolation.
    it("carries the funding org's ids on a trade another org created", async () => {
      await fundDvpTradeLeg(context, trade(), {
        side: "b",
        custodyWalletId: "cwlt_b_of_org_b",
        organizationId: "org_b",
        projectId: "prj_b",
        recordAttempt,
      });

      expect(claimFunding).toHaveBeenCalledWith(
        expect.objectContaining({
          tradeId: "dvp_fund_test",
          side: "b",
          organizationId: "org_b",
          projectId: "prj_b",
          custodyWalletId: "cwlt_b_of_org_b",
        })
      );
    });

    // Bilateral funding is two separate calls, one claim each: opposite sides
    // never contend, because the key includes the side.
    it("takes one row per side, with no contention between them", async () => {
      await fundDvpTradeLeg(context, trade(), {
        side: "a",
        custodyWalletId: "cwlt_a",
        organizationId: "org_a",
        projectId: "prj_a",
        recordAttempt,
      });
      await fundDvpTradeLeg(context, trade(), {
        side: "b",
        custodyWalletId: "cwlt_b",
        organizationId: "org_b",
        projectId: "prj_b",
        recordAttempt,
      });

      expect(claimFunding).toHaveBeenCalledTimes(2);
      expect(claimFunding).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ side: "a", organizationId: "org_a", custodyWalletId: "cwlt_a" })
      );
      expect(claimFunding).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ side: "b", organizationId: "org_b", custodyWalletId: "cwlt_b" })
      );
    });
  });

  // PRO-1973. The leg is locked first, then the trade read: a settle or cancel
  // that locked the trade before that read is in flight, so this backs off and
  // frees the leg for it. One that locks after sees the leg's lock instead.
  it("backs off before sponsorship and frees the leg when a settle or cancel is in flight", async () => {
    const closing = conflict("a settle is in flight on this trade", {
      reason: DVP_LEG_REFUSAL.tradeClosing,
    });
    assertTradeNotClosing.mockRejectedValue(closing);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toBe(closing);

    expect(claimFunding.mock.invocationCallOrder[0]).toBeLessThan(
      assertTradeNotClosing.mock.invocationCallOrder[0]
    );
    expect(releaseFunding).toHaveBeenCalledWith(
      trade().id,
      "a",
      claimFunding.mock.calls[0][0].signature
    );
    expect(prepareOwnedSubmission).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
  });
});
