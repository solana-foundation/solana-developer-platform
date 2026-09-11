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
 * (trade, side) and owned by the organization whose wallet is paying.
 */

import { SwapDvpVerificationError } from "@sdp/dvp";
import {
  address,
  none,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  some,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import type { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const beginApprovedWalletOperationEffect = vi.hoisted(() => vi.fn());
const readEscrowState = vi.hoisted(() => vi.fn());
const readDvpAccounts = vi.hoisted(() => vi.fn());
const verifySwapDvpAccount = vi.hoisted(() => vi.fn());
const decodeSwapDvpChecked = vi.hoisted(() => vi.fn());
const readMintDecimals = vi.hoisted(() => vi.fn());
const claimFunding = vi.hoisted(() => vi.fn());
const releaseFunding = vi.hoisted(() => vi.fn());
const recordFundingTx = vi.hoisted(() => vi.fn());
const fetchMaybeToken = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/policy/approved-operation-replay", () => ({
  beginApprovedWalletOperationEffect,
}));
vi.mock("./read-chain", () => ({ readEscrowState, readDvpAccounts }));
vi.mock("@sdp/dvp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/dvp")>()),
  verifySwapDvpAccount,
  decodeSwapDvpChecked,
}));
vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories/dvp-leg-funding-claim.repository", () => ({
  createPostgresDvpLegFundingClaimRepository: () => ({
    claim: claimFunding,
    release: releaseFunding,
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

const { fundDvpTradeLeg, readDvpLegShortfall } = await import("./fund");

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_fund_test",
    organizationId: "org_a",
    projectId: "prj_a",
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"),
    userA: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userB: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    nonce: "42",
    tokenProgramA: address(T22),
    tokenProgramB: address(T22),
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "USDC",
    nameA: "Acme Treasury Debt",
    nameB: "USD Coin",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    userASettlementDestination: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userBSettlementDestination: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    refString: null,
    escrowA: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
    escrowB: address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y"),
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    status: "created",
    observedAt: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    closeSignature: null,
    closeResolutionAttempts: 0,
    closeResolutionAfter: null,
    escrowAAmount: null,
    escrowBAmount: null,
    escrowAPeakAmount: null,
    escrowBPeakAmount: null,
    escrowAFrozen: null,
    escrowBFrozen: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

/** The funder: whoever's custody wallet holds the side's party address. */
const FUNDER_A = {
  side: "a" as const,
  custodyWalletId: "cwlt_a",
  organizationId: "org_x",
  projectId: "prj_x",
  approvedAmount: 1000n,
};

const context = { env } as never;

describe("fundDvpTradeLeg", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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
    beginApprovedWalletOperationEffect.mockResolvedValue(undefined);
    sendTransaction.mockResolvedValue("sig");
    claimFunding.mockResolvedValue(true);
    releaseFunding.mockResolvedValue(undefined);
    recordFundingTx.mockResolvedValue(undefined);
  });

  it("moves the named side's leg into its escrow", async () => {
    const result = await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(result.leg).toBe("a");
    // The trade's amount, never a caller's number.
    expect(result.amount).toBe("1000");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("funds leg B when that is the side named", async () => {
    const result = await fundDvpTradeLeg(context, trade(), {
      side: "b",
      custodyWalletId: "cwlt_b",
      organizationId: "org_x",
      projectId: "prj_x",
      approvedAmount: 2000n,
    });

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

    await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(order).toEqual(["fence", "send"]);
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

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /nothing left to fund/
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a leg already holding more than its target", async () => {
    readEscrowState.mockResolvedValue({ amount: 5000n, frozen: false });

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /nothing left to fund/
    );
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

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(/frozen/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a fundable leg whose escrow is missing", async () => {
    readEscrowState.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /escrow for this leg is missing; nothing was sent/
    );
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
    });
    expect(claimFunding).not.toHaveBeenCalled();
  });

  it("refuses a trade that is no longer verifiable on chain", async () => {
    verifySwapDvpAccount.mockRejectedValue(
      new SwapDvpVerificationError("there is no SwapDvp at that address")
    );

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /trade is no longer on chain; nothing was sent/
    );
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

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /on-chain trade does not match the recorded terms; nothing was sent/
    );
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

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /on-chain trade does not match the recorded terms; nothing was sent/
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("aborts when the live shortfall exceeds the approved amount", async () => {
    readEscrowState.mockResolvedValue({ amount: 0n, frozen: false });

    await expect(
      fundDvpTradeLeg(context, trade(), { ...FUNDER_A, approvedAmount: 100n })
    ).rejects.toThrow(/shortfall grew to 1000 after approval for 100; re-authorize/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a trade that can no longer be funded", async () => {
    for (const status of ["settled", "cancelled", "closed_unknown", "create_failed"] as const) {
      await expect(fundDvpTradeLeg(context, trade({ status }), FUNDER_A)).rejects.toThrow(
        /can no longer be funded/
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // The balance read and the transfer are not atomic, so the claim is what
  // makes exactly one of two overlapping requests broadcast.
  it("refuses to broadcast when another request holds the funding claim", async () => {
    claimFunding.mockResolvedValue(false);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
      /already being funded/
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("claims before it broadcasts", async () => {
    const order: string[] = [];
    claimFunding.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    sendTransaction.mockImplementation(async () => {
      order.push("send");
      return "sig";
    });

    await fundDvpTradeLeg(context, trade(), FUNDER_A);

    expect(order).toEqual(["claim", "send"]);
  });

  // An ambiguous send may still land, so releasing the claim would invite a
  // second transfer on top of the first.
  it("keeps the claim when a send fails ambiguously", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow("socket hang up");
    expect(releaseFunding).not.toHaveBeenCalled();
  });

  // The fence runs after the claim and before any broadcast. If it throws, no
  // bytes left this process, so holding the claim would make the leg
  // permanently unfundable over a failure that changed nothing.
  it("releases the claim when the approval fence fails, since nothing was sent", async () => {
    beginApprovedWalletOperationEffect.mockRejectedValue(new Error("fence unavailable"));

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow("fence unavailable");

    expect(releaseFunding).toHaveBeenCalledTimes(1);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the mint cannot be read", async () => {
    readMintDecimals.mockResolvedValue(null);

    await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(/could not be read/);
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
          `Program ${T22} failed: incorrect program id for instruction`,
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

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
        /no longer the amount owed/
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    // Aborting has to be free. The re-read sits before both the claim and the
    // approval fence so a refusal leaves no claim to release and does not burn
    // the approval's execution lease — otherwise the retry this error invites
    // would need a fresh approval.
    it("costs neither the funding claim nor the approval lease", async () => {
      readEscrowState
        .mockResolvedValueOnce({ amount: 0n, frozen: false })
        .mockResolvedValueOnce({ amount: 400n, frozen: false });

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
        /no longer the amount owed/
      );

      expect(claimFunding).not.toHaveBeenCalled();
      expect(beginApprovedWalletOperationEffect).not.toHaveBeenCalled();
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
        approvedAmount: 2000n,
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
        approvedAmount: 1000n,
      });
      await fundDvpTradeLeg(context, trade(), {
        side: "b",
        custodyWalletId: "cwlt_b",
        organizationId: "org_b",
        projectId: "prj_b",
        approvedAmount: 2000n,
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

    // The second fund of the SAME side while a claim is live is the one case
    // that must conflict — the claim CAS is the serialization.
    it("is refused for the same side while a claim is live", async () => {
      claimFunding.mockResolvedValue(false);

      await expect(fundDvpTradeLeg(context, trade(), FUNDER_A)).rejects.toThrow(
        /already being funded/
      );
      expect(claimFunding).toHaveBeenCalledWith(
        expect.objectContaining({ tradeId: "dvp_fund_test", side: "a" })
      );
    });
  });
});

// Exported for the policy extractor, which has to put the amount that will
// actually move in front of an approver rather than the leg's target.
describe("readDvpLegShortfall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the outstanding balance for a partly funded leg", async () => {
    readEscrowState.mockResolvedValue({ amount: 400n, frozen: false });

    await expect(readDvpLegShortfall(env, trade(), "a")).resolves.toBe(600n);
  });

  it("refuses to invent a zero balance when the escrow is missing", async () => {
    readEscrowState.mockResolvedValue(null);

    await expect(readDvpLegShortfall(env, trade(), "a")).rejects.toThrow(
      /escrow for this leg is missing; nothing was sent/
    );
  });

  it("reads the side asked for, not always leg A", async () => {
    readEscrowState.mockResolvedValue({ amount: 500n, frozen: false });

    await expect(readDvpLegShortfall(env, trade(), "b")).resolves.toBe(1500n);
  });

  // Never negative. An over-funded leg has nothing outstanding, and a negative
  // amount reaching a policy rule would compare as under every limit.
  it("clamps an over-funded leg to zero rather than going negative", async () => {
    readEscrowState.mockResolvedValue({ amount: 4000n, frozen: false });

    await expect(readDvpLegShortfall(env, trade(), "a")).resolves.toBe(0n);
  });
});
