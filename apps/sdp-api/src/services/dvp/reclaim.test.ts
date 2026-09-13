/**
 * Reclaiming one side of a trade.
 *
 * Two things matter here beyond the refusals. The account wiring, because a
 * reclaim built against the wrong mint or token program is refused on chain,
 * and the generated builders elsewhere once defaulted the token program. And
 * the receipt, because a leg SDP funded keeps its claim row, and unless the
 * reclaim clears it the next funding of that leg conflicts forever.
 */

import assert from "node:assert/strict";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { DVP_LEG_REFUSAL, MEMO_PROGRAM_ADDRESS } from "@sdp/types";
import {
  address,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { generateKeyPairSigner, partiallySignTransactionWithSigners } from "@solana/signers";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import type { OwnedSubmissionLifecycle } from "@/services/sponsorship.service";
import { env } from "@/test/helpers/env";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const readDvpAccounts = vi.hoisted(() => vi.fn());
const verifySwapDvpAccount = vi.hoisted(() => vi.fn());
const claimForReclaim = vi.hoisted(() => vi.fn());
const rebindSignature = vi.hoisted(() => vi.fn());
const hasClaim = vi.hoisted(() => vi.fn());
const releaseClaim = vi.hoisted(() => vi.fn());
const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());
const prepareOwnedSubmission = vi.hoisted(() => vi.fn());
const fetchMaybeMint = vi.hoisted(() => vi.fn());

let sponsorSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let partySigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

/** Co-signs a partially signed transaction as the sponsor, the way Kora would. */
async function sponsorSign(transaction: Uint8Array, lifecycle: OwnedSubmissionLifecycle) {
  const decoded = getTransactionDecoder().decode(transaction);
  const signed = await partiallySignTransactionWithSigners([sponsorSigner], decoded);
  const signature = getSignatureFromTransaction(signed);
  const signedTransaction = new Uint8Array(getTransactionEncoder().encode(signed));
  await lifecycle.persistSigned({ signature, signedTransaction });
  await lifecycle.markStarted();
  return { signature, signedTransaction, releaseDefinitelyUnbroadcast: vi.fn() };
}

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createProjectSponsorshipFeePayment,
}));
vi.mock("./read-chain", () => ({ readDvpAccounts }));
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
}));

const { reclaimDvpTradeLeg } = await import("./reclaim");

function trade(overrides: Partial<DvpTradeRow> = {}): DvpTradeRow {
  return {
    id: "dvp_reclaim_test",
    organizationId: "org_a",
    projectId: "prj_a",
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"),
    userA: partySigner.address,
    userB: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    nonce: "42",
    tokenProgramA: TOKEN_2022_PROGRAM_ADDRESS,
    tokenProgramB: TOKEN_PROGRAM_ADDRESS,
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
    userASettlementDestination: partySigner.address,
    userBSettlementDestination: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    refString: null,
    escrowA: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
    escrowB: address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y"),
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    status: "funded",
    observedAt: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    closeSignature: null,
    closeResolutionAttempts: 0,
    closeResolutionAfter: null,
    closedAt: null,
    escrowAAmount: "1000",
    escrowBAmount: "2000",
    escrowAPeakAmount: "1000",
    escrowBPeakAmount: "2000",
    escrowAFrozen: false,
    escrowBFrozen: false,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

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
    sponsorSigner = await generateKeyPairSigner();
    partySigner = await generateKeyPairSigner();
    createOrgSignerForCustodyWallet.mockResolvedValue(partySigner);
    readDvpAccounts.mockResolvedValue({
      trade: { address: trade().swapDvp, exists: true },
      legA: { exists: true, amount: 1000n, frozen: false },
      legB: { exists: true, amount: 2000n, frozen: false },
    });
    verifySwapDvpAccount.mockResolvedValue({ address: trade().swapDvp });
    fetchMaybeMint.mockResolvedValue({ exists: true, data: { extensions: { __option: "None" } } });
    claimForReclaim.mockResolvedValue(true);
    rebindSignature.mockResolvedValue(true);
    hasClaim.mockResolvedValue(true);
    releaseClaim.mockResolvedValue(undefined);
    prepareOwnedSubmission.mockImplementation(sponsorSign);
    createProjectSponsorshipFeePayment.mockResolvedValue({
      getFeePayer: async () => sponsorSigner.address,
      prepareOwnedSubmission,
    });
    sendTransaction.mockImplementation(async (_rpc, bytes) =>
      getSignatureFromTransaction(getTransactionDecoder().decode(bytes))
    );
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

  // The leg's lock is taken before anything is sent, so a funding can't start
  // between a check and the broadcast, and it is released once the reclaim is
  // on the wire, which is what lets the leg be funded again.
  it("holds the leg's lock across the send, then releases its own signature", async () => {
    const result = await reclaimDvpTradeLeg(context, trade(), RECLAIMER_A);

    expect(claimForReclaim).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "dvp_reclaim_test", side: "a", expiryHeight: "100" })
    );
    expect(claimForReclaim.mock.invocationCallOrder[0]).toBeLessThan(
      sendTransaction.mock.invocationCallOrder[0]
    );
    expect(releaseClaim).toHaveBeenCalledWith("dvp_reclaim_test", "a", result.signature);
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
  it("refuses, sending nothing, when the leg's lock is already held", async () => {
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

    await expect(reclaimDvpTradeLeg(context, trade(), RECLAIMER_A)).rejects.toThrow(
      /no longer signs as side a's party/
    );
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
  });
});
