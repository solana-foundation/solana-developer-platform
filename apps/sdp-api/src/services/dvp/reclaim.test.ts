/**
 * Reclaiming one side of a trade.
 *
 * Three things matter beyond the refusals. The account wiring, because a
 * reclaim built against the wrong mint or token program is refused on chain.
 * The receipt, because a funding row is written at broadcast and a reclaim that
 * took over one whose transfer had not landed would drain today's balance and
 * let that funding land afterwards. And the lock's lifetime: held until the
 * reclaim confirms, so nothing reads the escrow as still full in between.
 */

import assert from "node:assert/strict";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { DVP_LEG_REFUSAL, MEMO_PROGRAM_ADDRESS } from "@sdp/types";
import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { acceptTransaction, buildDvpTradeRow, createTestSponsor } from "@/test/fixtures/dvp";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const readDvpAccounts = vi.hoisted(() => vi.fn());
const verifySwapDvpAccount = vi.hoisted(() => vi.fn());
const claimForReclaim = vi.hoisted(() => vi.fn());
const rebindSignature = vi.hoisted(() => vi.fn());
const hasClaim = vi.hoisted(() => vi.fn());
const releaseClaim = vi.hoisted(() => vi.fn());
const listForTrade = vi.hoisted(() => vi.fn());
const readDvpFundingReceipt = vi.hoisted(() => vi.fn());
const confirmTransaction = vi.hoisted(() => vi.fn());
const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());
const prepareOwnedSubmission = vi.hoisted(() => vi.fn());
const fetchMaybeMint = vi.hoisted(() => vi.fn());

let partySigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createProjectSponsorshipFeePayment,
}));
vi.mock("./read-chain", () => ({ readDvpAccounts }));
vi.mock("./funding-receipt", () => ({ readDvpFundingReceipt }));
vi.mock("@sdp/dvp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/dvp")>()),
  verifySwapDvpAccount,
}));
vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories/dvp-leg-funding-claim.repository", () => ({
  createPostgresDvpLegFundingClaimRepository: () => ({
    claimForReclaim,
    rebindSignature,
    hasClaim,
    listForTrade,
    release: releaseClaim,
  }),
}));
vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMaybeMint,
}));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getRecentBlockhash: async () => ({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 100n,
  }),
  sendTransaction,
  confirmTransaction,
}));

const { reclaimDvpTradeLeg } = await import("./reclaim");

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return buildDvpTradeRow({
    id: "dvp_reclaim_test",
    userA: partySigner.address,
    // Leg B is a legacy SPL mint, so the wiring test below has two programs to tell apart.
    tokenProgramA: TOKEN_2022_PROGRAM_ADDRESS,
    tokenProgramB: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  });
}

/** What a funding row on the leg looks like: a lock until `fundingTx` is set. */
function claimRow(fundingTx: string | null) {
  return {
    tradeId: "dvp_reclaim_test",
    side: "a",
    organizationId: "org_a",
    projectId: "prj_a",
    custodyWalletId: "cwlt_a",
    signature: RECEIPT,
    expiryHeight: "90",
    fundingTx,
  };
}

const RECEIPT =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const RECLAIMER_A = {
  side: "a" as const,
  custodyWalletId: "cwlt_a",
  organizationId: "org_a",
  projectId: "prj_a",
};

const context = { env } as never;

/** The instructions of the one transaction that went out. */
function sentInstructions() {
  const transaction = getTransactionDecoder().decode(sendTransaction.mock.calls[0][1]);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  assert(message.version === 0);
  return message.instructions.map((instruction) => {
    assert(instruction.accountIndices);
    return {
      program: message.staticAccounts[instruction.programAddressIndex],
      accounts: instruction.accountIndices.map((index) => message.staticAccounts[index]),
    };
  });
}

describe("reclaimDvpTradeLeg", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const sponsor = await createTestSponsor();
    partySigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWallet.mockResolvedValue(partySigner);
    readDvpAccounts.mockResolvedValue({
      trade: { address: trade().swapDvp, exists: true },
      legA: { exists: true, amount: 1000n, frozen: false },
      legB: { exists: true, amount: 2000n, frozen: false },
      clusterUnixTimestamp: 1_800_000_000n,
    });
    verifySwapDvpAccount.mockResolvedValue({ address: trade().swapDvp });
    fetchMaybeMint.mockResolvedValue({ exists: true, data: { extensions: { __option: "None" } } });
    listForTrade.mockResolvedValue([]);
    claimForReclaim.mockResolvedValue(true);
    rebindSignature.mockResolvedValue(true);
    hasClaim.mockResolvedValue(true);
    releaseClaim.mockResolvedValue(undefined);
    prepareOwnedSubmission.mockImplementation(sponsor.prepareOwnedSubmission);
    createProjectSponsorshipFeePayment.mockResolvedValue({
      getFeePayer: async () => sponsor.address,
      prepareOwnedSubmission,
    });
    sendTransaction.mockImplementation(acceptTransaction);
    confirmTransaction.mockImplementation(async (_rpc, signature) => ({
      signature,
      slot: 1n,
      confirmationStatus: "confirmed",
      err: null,
    }));
  });

  it("drains leg A's escrow into the party's own token account for that mint", async () => {
    const row = trade();
    const result = await reclaimDvpTradeLeg(context, row, RECLAIMER_A);

    expect(result).toMatchObject({ leg: "a", amount: "1000" });
    const [destination] = await findAssociatedTokenPda({
      owner: row.userA,
      mint: row.mintA,
      tokenProgram: row.tokenProgramA,
    });
    const [createAta, reclaim] = sentInstructions();
    expect(createAta.program).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    // Layout per reclaim_dvp.rs: signer, swap_dvp, mint, source, destination, token program, memo.
    expect(reclaim.program).toBe(DVP_SWAP_PROGRAM_PROGRAM_ADDRESS);
    expect(reclaim.accounts).toEqual([
      row.userA,
      row.swapDvp,
      row.mintA,
      row.escrowA,
      destination,
      row.tokenProgramA,
      MEMO_PROGRAM_ADDRESS,
    ]);
  });

  // The builders elsewhere once defaulted the token program to Token-2022.
  // Leg B here is a legacy SPL mint, and has to go out as one.
  it("sends leg B with leg B's mint and its own token program", async () => {
    const other = trade({
      userB: partySigner.address,
      userA: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    });

    await reclaimDvpTradeLeg(context, other, { ...RECLAIMER_A, side: "b" });

    const [, reclaim] = sentInstructions();
    expect(reclaim.accounts[2]).toBe(other.mintB);
    expect(reclaim.accounts[3]).toBe(other.escrowB);
    expect(reclaim.accounts[5]).toBe(TOKEN_PROGRAM_ADDRESS);
  });

  // Taken before anything is sent, so a funding can't start between a check and
  // the broadcast, and released once the reclaim confirms, which is what lets the
  // leg be funded again without anything reading the escrow as still full.
  it("holds the leg's lock from before the send until the reclaim confirms", async () => {
    const result = await reclaimDvpTradeLeg(context, trade(), RECLAIMER_A);

    expect(claimForReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "dvp_reclaim_test", side: "a", expiryHeight: "100" }),
      null
    );
    expect(claimForReclaim.mock.invocationCallOrder[0]).toBeLessThan(
      sendTransaction.mock.invocationCallOrder[0]
    );
    expect(confirmTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      releaseClaim.mock.invocationCallOrder[0]
    );
    expect(releaseClaim).toHaveBeenCalledWith("dvp_reclaim_test", "a", result.signature);
  });

  // On the wire is not landed. A second reclaim, or a funding, let in now would
  // read the escrow still full and send on top of this one.
  it("keeps the lock when the reclaim does not confirm in time", async () => {
    confirmTransaction.mockRejectedValue(new Error("confirmation timed out after 15000ms"));

    const result = await reclaimDvpTradeLeg(context, trade(), RECLAIMER_A);

    expect(result.signature).toEqual(expect.any(String));
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  // A processed status can still be dropped with its fork.
  it("keeps the lock when the reclaim is only processed", async () => {
    confirmTransaction.mockImplementation(async (_rpc, signature) => ({
      signature,
      slot: 1n,
      confirmationStatus: "processed",
      err: { InstructionError: [1, { Custom: 1 }] },
    }));

    await reclaimDvpTradeLeg(context, trade(), RECLAIMER_A);

    expect(releaseClaim).not.toHaveBeenCalled();
  });

  // It may still land, so a funding on top of it would be the race again.
  it("keeps the lock when the send fails ambiguously", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toThrow();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("releases the lock when the cluster rejects the transaction in preflight", async () => {
    sendTransaction.mockRejectedValue(
      new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
        accounts: null,
        fee: null,
        loadedAccountsDataSize: null,
        loadedAddresses: null,
        logs: [],
        postBalances: null,
        postTokenBalances: null,
        preBalances: null,
        preTokenBalances: null,
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: null,
      })
    );

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toThrow();
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });

  // No expiry gate on chain: a deposit can always come back.
  it("reclaims from an expired trade", async () => {
    await reclaimDvpTradeLeg(context, trade({ status: "expired" }), RECLAIMER_A);

    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    "settled",
    "cancelled",
    "rejected",
    "closed_unknown",
    "create_failed",
    "creating",
  ] as const)("refuses a %s trade before reading the chain", async (status) => {
    await expect(reclaimDvpTradeLeg(context, trade({ status }), RECLAIMER_A)).rejects.toMatchObject(
      { details: { reason: DVP_LEG_REFUSAL.tradeNotReclaimable } }
    );
    expect(readDvpAccounts).not.toHaveBeenCalled();
  });

  // A funding in flight holds the lock, and reclaiming over it is the race.
  it("refuses, sending nothing, when a funding still holds the leg's lock", async () => {
    listForTrade.mockResolvedValue([claimRow(null)]);

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.legFundingInProgress },
    });
    expect(readDvpFundingReceipt).not.toHaveBeenCalled();
    expect(createOrgSignerForCustodyWallet).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // The funding was written at broadcast and has not confirmed. Reclaiming now
  // drains today's balance and the funding lands after, re-funding the leg.
  it("refuses to take over a receipt whose funding has not landed yet", async () => {
    listForTrade.mockResolvedValue([claimRow(RECEIPT)]);
    readDvpFundingReceipt.mockResolvedValue("pending");

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.legFundingInProgress },
    });
    expect(readDvpFundingReceipt).toHaveBeenCalledWith(expect.anything(), {
      fundingTx: RECEIPT,
      expiryHeight: "90",
    });
    expect(claimForReclaim).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it.each(["landed", "moved_nothing"] as const)(
    "takes over a receipt whose funding %s, guarded on that exact signature",
    async (state) => {
      listForTrade.mockResolvedValue([claimRow(RECEIPT)]);
      readDvpFundingReceipt.mockResolvedValue(state);

      await reclaimDvpTradeLeg(context, trade(), RECLAIMER_A);

      expect(claimForReclaim).toHaveBeenCalledWith(
        expect.objectContaining({ tradeId: "dvp_reclaim_test", side: "a" }),
        RECEIPT
      );
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    }
  );

  // The receipt changed between the chain read and the guarded takeover.
  it("refuses when the leg's row changed after it was checked", async () => {
    claimForReclaim.mockResolvedValue(false);

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.legFundingInProgress },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  // The program no-ops an empty escrow; sending one spends a sponsored fee on nothing.
  it("refuses an empty escrow without asking for sponsorship", async () => {
    readDvpAccounts.mockResolvedValue({
      trade: { address: trade().swapDvp, exists: true },
      legA: { exists: true, amount: 0n, frozen: false },
      legB: { exists: true, amount: 2000n, frozen: false },
      clusterUnixTimestamp: 1_800_000_000n,
    });

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.nothingToReclaim },
    });
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a tampered escrow", async () => {
    readDvpAccounts.mockResolvedValue({
      trade: { address: trade().swapDvp, exists: true },
      legA: { exists: false, tampered: true },
      legB: { exists: true, amount: 2000n, frozen: false },
      clusterUnixTimestamp: 1_800_000_000n,
    });

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.escrowMismatch },
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // The hook's extra accounts are not resolved, so the refund CPI would fail.
  it("refuses a transfer-hook mint rather than sending a reclaim the token program refuses", async () => {
    fetchMaybeMint.mockResolvedValue({
      exists: true,
      data: { extensions: { __option: "Some", value: [{ __kind: "TransferHook" }] } },
    });

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      details: { reason: DVP_LEG_REFUSAL.transferHookUnsupported },
    });
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
  });

  // The program only accepts the party. A wallet whose key no longer resolves
  // to that address would build a transaction it refuses.
  it("refuses when the custody signer is not the party address", async () => {
    createOrgSignerForCustodyWallet.mockResolvedValue(await generateKeyPairSigner());

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toMatchObject({
      message: expect.stringMatching(/no longer signs as side a's party/),
      details: { reason: DVP_LEG_REFUSAL.signerNotParty },
    });
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
  });
});
