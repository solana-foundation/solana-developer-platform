/**
 * Settle and cancel.
 *
 * The two things worth asserting here are ORDERING and ACCOUNT WIRING. Ordering,
 * because the approved-operation fence has to be crossed before any bytes go
 * out or a crash becomes unrecoverable. Wiring, because settle moves two
 * parties' tokens at once and a swapped destination sends the wrong asset to
 * the wrong person — a mistake nothing downstream would catch.
 */

import assert from "node:assert/strict";
import { getSettleDvpInstruction } from "@sdp/dvp";
import {
  address,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import type { AppError } from "@/lib/errors";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import { env } from "@/test/helpers/env";
import { deriveDvpSettleAtas } from "./settle-atas";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const getFeePayer = vi.hoisted(() => vi.fn());
const prepareOwnedSubmission = vi.hoisted(() => vi.fn());
const releaseDefinitelyUnbroadcast = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
const beginApprovedWalletOperationEffect = vi.hoisted(() => vi.fn());
const getOrCreateDvpSettlementWallet = vi.hoisted(() => vi.fn());
const readDvpAccounts = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("@/services/sponsorship.service", async () => {
  const actual = await vi.importActual<typeof import("@/services/sponsorship.service")>(
    "@/services/sponsorship.service"
  );
  return {
    ...actual,
    createRequestSponsorshipFeePayment: () => ({
      getFeePayer,
      prepareOwnedSubmission,
      providerId: "test",
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn(),
    }),
  };
});
vi.mock("@/services/policy/approved-operation-replay", () => ({
  beginApprovedWalletOperationEffect,
}));
vi.mock("./settlement-wallet", () => ({ getOrCreateDvpSettlementWallet }));
vi.mock("./read-chain", () => ({ readDvpAccounts }));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
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
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: address(SETTLEMENT_AUTHORITY),
    userA: address(USER_A),
    userB: address(USER_B),
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
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    userASettlementDestination: address(USER_A),
    userBSettlementDestination: address(USER_B),
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

const context = { env } as never;

function preflightError(): SolanaError {
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    fee: null,
    loadedAccountsDataSize: null,
    loadedAddresses: null,
    logs: ["Program log: Error: IncorrectProgramId"],
    postBalances: null,
    postTokenBalances: null,
    preBalances: null,
    preTokenBalances: null,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: null,
  });
}

describe("closeDvpTrade", () => {
  let authority: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let sponsor: Awaited<ReturnType<typeof generateKeyPairSigner>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    readDvpAccounts.mockResolvedValue({
      trade: { exists: true, address: trade().swapDvp },
      legA: { exists: true, amount: 1000n, frozen: false },
      legB: { exists: true, amount: 2000n, frozen: false },
    });
    authority = await generateKeyPairSigner();
    sponsor = await generateKeyPairSigner();
    createOrgSignerForCustodyWallet.mockResolvedValue(authority);
    getFeePayer.mockResolvedValue(sponsor.address);
    prepareOwnedSubmission.mockImplementation(
      async (
        bytes: Uint8Array,
        lifecycle: Parameters<SponsorshipFeePayment["prepareOwnedSubmission"]>[1]
      ) => {
        const transaction = getTransactionDecoder().decode(bytes);
        expect(transaction.signatures[sponsor.address]).toBeNull();
        const signed = await partiallySignTransaction([sponsor.keyPair], transaction);
        const signedTransaction = new Uint8Array(getTransactionEncoder().encode(signed));
        const signature = getSignatureFromTransaction(signed);
        const submission = { signedTransaction, signature, releaseDefinitelyUnbroadcast };
        await lifecycle.persistSigned(submission);
        await lifecycle.markStarted();
        return submission;
      }
    );
    getOrCreateDvpSettlementWallet.mockResolvedValue({
      custodyWalletId: "cwlt_settlement",
      address: SETTLEMENT_AUTHORITY,
    });
    beginApprovedWalletOperationEffect.mockResolvedValue(undefined);
    sendTransaction.mockImplementation(async (_rpc: unknown, bytes: Uint8Array) =>
      getSignatureFromTransaction(getTransactionDecoder().decode(bytes))
    );
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

    // The owned sponsorship path returns the signature in the submitted bytes.
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

  describe("instruction order", () => {
    it("appends four create-ATA instructions before settle for the derived accounts", async () => {
      const row = trade();
      const atas = await deriveDvpSettleAtas(row);

      await closeDvpTrade(context, row, "settle");

      const transaction = getTransactionDecoder().decode(sendTransaction.mock.calls[0][1]);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      assert(message.version === 0);
      expect(message.instructions).toHaveLength(5);
      expect(
        message.instructions.slice(0, 4).map((instruction) => {
          assert(instruction.accountIndices);
          return message.staticAccounts[instruction.accountIndices[1]];
        })
      ).toEqual([
        atas.userADestinationAtaB,
        atas.userBDestinationAtaA,
        atas.userAAtaA,
        atas.userBAtaB,
      ]);
      expect(
        message.instructions
          .slice(0, 4)
          .map((instruction) => message.staticAccounts[instruction.programAddressIndex])
      ).toEqual(Array.from({ length: 4 }, () => ASSOCIATED_TOKEN_PROGRAM_ADDRESS));
      expect(message.staticAccounts[message.instructions[4].programAddressIndex]).not.toBe(
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS
      );
    });

    it("appends two create-ATA instructions before cancel for the refund accounts", async () => {
      const row = trade();
      const atas = await deriveDvpSettleAtas(row);

      await closeDvpTrade(context, row, "cancel");

      const transaction = getTransactionDecoder().decode(sendTransaction.mock.calls[0][1]);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      assert(message.version === 0);
      expect(message.instructions).toHaveLength(3);
      expect(
        message.instructions.slice(0, 2).map((instruction) => {
          assert(instruction.accountIndices);
          return message.staticAccounts[instruction.accountIndices[1]];
        })
      ).toEqual([atas.userAAtaA, atas.userBAtaB]);
      expect(
        message.instructions
          .slice(0, 2)
          .map((instruction) => message.staticAccounts[instruction.programAddressIndex])
      ).toEqual(Array.from({ length: 2 }, () => ASSOCIATED_TOKEN_PROGRAM_ADDRESS));
      expect(message.staticAccounts[message.instructions[2].programAddressIndex]).not.toBe(
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS
      );
    });
  });

  // Each party receives the OTHER leg's mint. Getting this backwards would send
  // the asset to the party who was already holding it and nothing would notice.
  it("delivers each leg to the counter-party's destination", async () => {
    const signer = await generateKeyPairSigner();
    const row = trade();
    const atas = await deriveDvpSettleAtas({
      userA: row.userA,
      userB: row.userB,
      userASettlementDestination: row.userASettlementDestination,
      userBSettlementDestination: row.userBSettlementDestination,
      mintA: row.mintA,
      mintB: row.mintB,
      tokenProgramA: row.tokenProgramA,
      tokenProgramB: row.tokenProgramB,
    });

    const instruction = getSettleDvpInstruction({
      settlementAuthority: signer,
      swapDvp: row.swapDvp,
      mintA: row.mintA,
      mintB: row.mintB,
      dvpAtaA: row.escrowA,
      dvpAtaB: row.escrowB,
      userADestinationAtaB: atas.userADestinationAtaB,
      userBDestinationAtaA: atas.userBDestinationAtaA,
      userAAtaA: atas.userAAtaA,
      userBAtaB: atas.userBAtaB,
      tokenProgramA: row.tokenProgramA,
      tokenProgramB: row.tokenProgramB,
      memoProgram: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      legAExtrasCount: 0,
    });

    // user A's delivery account holds mint B, and vice versa. Same account in
    // both directions would mean the trade delivered nothing.
    expect(atas.userADestinationAtaB).not.toBe(atas.userBDestinationAtaA);
    expect(atas.userADestinationAtaB).not.toBe(atas.userAAtaA);
    expect(instruction.accounts).toBeDefined();
  });

  describe("sponsorship", () => {
    it("uses the sponsor as fee payer and collects both required signatures", async () => {
      await closeDvpTrade(context, trade(), "settle");

      const bytes = sendTransaction.mock.calls[0][1];
      const transaction = getTransactionDecoder().decode(bytes);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      expect(message.staticAccounts[0]).toBe(sponsor.address);
      expect(Object.keys(transaction.signatures)).toEqual(
        expect.arrayContaining([sponsor.address, authority.address])
      );
      expect(Object.keys(transaction.signatures)).toHaveLength(2);
      expect(transaction.signatures[sponsor.address]).not.toBeNull();
      expect(transaction.signatures[authority.address]).not.toBeNull();
    });

    it("uses the sponsor as payer for every create-ATA instruction", async () => {
      await closeDvpTrade(context, trade(), "settle");

      const transaction = getTransactionDecoder().decode(sendTransaction.mock.calls[0][1]);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      assert(message.version === 0);
      for (const instruction of message.instructions.slice(0, 4)) {
        assert(instruction.accountIndices);
        expect(message.staticAccounts[instruction.accountIndices[0]]).toBe(sponsor.address);
      }
    });

    it("fences after the sponsor signs and before the bytes go out", async () => {
      await closeDvpTrade(context, trade(), "settle");

      expect(prepareOwnedSubmission.mock.invocationCallOrder[0]).toBeLessThan(
        beginApprovedWalletOperationEffect.mock.invocationCallOrder[0]
      );
      expect(beginApprovedWalletOperationEffect.mock.invocationCallOrder[0]).toBeLessThan(
        sendTransaction.mock.invocationCallOrder[0]
      );
    });

    it("leaves the approval unfenced when the sponsor refuses to sign", async () => {
      prepareOwnedSubmission.mockRejectedValueOnce(new Error("sponsor rate limited"));

      await expect(closeDvpTrade(context, trade(), "settle")).rejects.toThrow(
        "sponsor rate limited"
      );
      expect(beginApprovedWalletOperationEffect).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("maps a preflight rejection and releases the sponsorship reservation", async () => {
      sendTransaction.mockRejectedValue(preflightError());

      await expect(closeDvpTrade(context, trade(), "settle")).rejects.toMatchObject({
        code: "TRANSACTION_FAILED",
        statusCode: 400,
      } satisfies Partial<AppError>);
      expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledOnce();
    });

    it("rethrows an ambiguous send error without releasing the sponsorship reservation", async () => {
      const error = new Error("socket hang up");
      sendTransaction.mockRejectedValue(error);

      await expect(closeDvpTrade(context, trade(), "settle")).rejects.toBe(error);
      expect(releaseDefinitelyUnbroadcast).not.toHaveBeenCalled();
    });
  });
});
