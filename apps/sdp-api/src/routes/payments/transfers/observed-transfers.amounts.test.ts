import { runInClusterScope } from "@sdp/rpc/scope";
import type { SignatureInfo } from "@sdp/rpc/solana";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { installClusterRpcResponder, type JsonRpcResult } from "@/test/helpers/cluster-rpc";
import {
  parsedSystemTransfer,
  parsedTokenBalance,
  parsedTransactionResult,
  parsedTransferChecked,
  signatureHistoryEntry,
  syntheticAddress,
} from "@/test/helpers/parsed-transactions";
import {
  buildObservedTransfersForSignatures,
  clearObservedTransferCaches,
} from "./observed-transfers";

/**
 * What an observed transfer moved (ADR 0012): base units from instruction
 * data and from the destination's raw balance change, never a display value,
 * with the verdict of comparing the two.
 */
const PAYER = syntheticAddress(1);
const WALLET = syntheticAddress(2);
const SENDER = syntheticAddress(3);
const SOURCE_TOKEN_ACCOUNT = syntheticAddress(4);
const WALLET_TOKEN_ACCOUNT = syntheticAddress(5);
const FEE_MINT = syntheticAddress(6);
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

const context = {
  organizationId: "org_observed_amounts",
  projectId: "prj_observed_amounts",
  walletIdsByAddress: new Map([[WALLET, "wal_observed_amounts"]]),
};

/** A token amount whose display string deliberately differs from its raw value, as a scaled mint's does. */
function scaledAmount(amount: string) {
  return { amount, decimals: 6, uiAmountString: "999999" };
}

function feeBalance(accountIndex: number, owner: string, amount: string): JsonRpcResult {
  const { uiAmountString, ...raw } = scaledAmount(amount);
  return {
    accountIndex,
    mint: FEE_MINT,
    owner,
    programId: TOKEN_2022,
    uiTokenAmount: { ...raw, uiAmount: Number(uiAmountString), uiAmountString },
  };
}

/** A Token-2022 transfer instruction of `type` into the wallet's token account. */
function token2022Transfer(
  type: "transferChecked" | "transferCheckedWithFee",
  amount: string,
  fee: string | null
): JsonRpcResult {
  const info = {
    source: SOURCE_TOKEN_ACCOUNT,
    destination: WALLET_TOKEN_ACCOUNT,
    mint: FEE_MINT,
    authority: SENDER,
    tokenAmount: scaledAmount(amount),
  };
  return {
    program: "spl-token-2022",
    programId: TOKEN_2022,
    parsed: { type, info: fee === null ? info : { ...info, feeAmount: scaledAmount(fee) } },
    stackHeight: 1,
  };
}

/** A transaction moving into the wallet's token account, which ends `credited` above where it started. */
function tokenTransaction(instruction: JsonRpcResult, credited: string): JsonRpcResult {
  return parsedTransactionResult({
    signature: "1".repeat(64),
    slot: 50,
    blockTime: 1700000000,
    accountKeys: [SENDER, SOURCE_TOKEN_ACCOUNT, WALLET_TOKEN_ACCOUNT],
    instructions: [instruction],
    innerInstructions: [],
    preTokenBalances: [feeBalance(1, SENDER, "10000000"), feeBalance(2, WALLET, "0")],
    postTokenBalances: [feeBalance(1, SENDER, "9000000"), feeBalance(2, WALLET, credited)],
  });
}

/** A transaction whose payer sends the wallet `lamports`, its balances moving by `received`. */
function solTransaction(lamports: number, received: number): JsonRpcResult {
  return {
    slot: 50,
    blockTime: 1700000000,
    version: 0,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [2_000_000_000, 1_000_000_000],
      postBalances: [2_000_000_000 - lamports - 5000, 1_000_000_000 + received],
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      signatures: ["1".repeat(64)],
      message: {
        accountKeys: [PAYER, WALLET].map((pubkey, index) => ({
          pubkey,
          signer: index === 0,
          source: "transaction",
          writable: true,
        })),
        instructions: [parsedSystemTransfer({ source: PAYER, destination: WALLET, lamports })],
      },
    },
  };
}

describe("observed transfer amounts", () => {
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    clearObservedTransferCaches();
  });

  async function observe(transaction: JsonRpcResult) {
    rpc.respond("getTransaction", () => ({ result: transaction }));
    const signatures: SignatureInfo[] = [signatureHistoryEntry(0, "confirmed")];
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      buildObservedTransfersForSignatures(signatures, context)
    );
  }

  it("reads a TransferCheckedWithFee, the credit basis inbound, verified by the raw balance change", async () => {
    const [observed] = await observe(
      tokenTransaction(token2022Transfer("transferCheckedWithFee", "1000000", "5000"), "995000")
    );

    expect(observed?.row).toMatchObject({ direction: "inbound", amount: "0.995", token: FEE_MINT });
    expect(observed?.movement).toEqual({
      asset: { kind: "token", mint: FEE_MINT, program: "token-2022" },
      basis: "credit",
      decimals: 6,
      amounts: { debit: 1_000_000n, fee: 5_000n, credit: 995_000n },
      verification: { state: "verified", reason: "chain_delta_matched" },
    });
  });

  it("takes the withheld fee from the balance change when a TransferChecked states none", async () => {
    const [observed] = await observe(
      tokenTransaction(token2022Transfer("transferChecked", "1000000", null), "990000")
    );

    expect(observed?.row.amount).toBe("0.99");
    expect(observed?.movement.amounts).toEqual({
      debit: 1_000_000n,
      fee: 10_000n,
      credit: 990_000n,
    });
    expect(observed?.movement.verification.state).toBe("verified");
  });

  it("credits nothing when the whole debit is withheld, as a rounded-up fee on a tiny transfer can", async () => {
    const [observed] = await observe(
      tokenTransaction(token2022Transfer("transferChecked", "1", null), "0")
    );

    expect(observed?.row.amount).toBe("0");
    expect(observed?.movement.amounts).toEqual({ debit: 1n, fee: 1n, credit: 0n });
    expect(observed?.movement.verification.state).toBe("verified");
  });

  it("counts moves between accounts no tracked wallet owns before inferring a fee", async () => {
    // The wallet sends 100 to an outside account, which forwards 90 in the same
    // transaction: the outside account keeps 10 and no fee was withheld.
    const outside = syntheticAddress(7);
    const outsideAccount = syntheticAddress(8);
    const onward = syntheticAddress(9);
    const plainTransfer = (
      source: string,
      destination: string,
      authority: string,
      amount: string
    ) => ({
      program: "spl-token-2022",
      programId: TOKEN_2022,
      parsed: {
        type: "transferChecked",
        info: { source, destination, mint: FEE_MINT, authority, tokenAmount: scaledAmount(amount) },
      },
      stackHeight: 1,
    });
    const [observed, ...others] = await observe(
      parsedTransactionResult({
        signature: "1".repeat(64),
        slot: 50,
        blockTime: 1700000000,
        accountKeys: [WALLET, WALLET_TOKEN_ACCOUNT, outsideAccount, onward],
        instructions: [
          plainTransfer(WALLET_TOKEN_ACCOUNT, outsideAccount, WALLET, "100"),
          plainTransfer(outsideAccount, onward, outside, "90"),
        ],
        innerInstructions: [],
        preTokenBalances: [
          feeBalance(1, WALLET, "1000"),
          feeBalance(2, outside, "0"),
          feeBalance(3, outside, "0"),
        ],
        postTokenBalances: [
          feeBalance(1, WALLET, "900"),
          feeBalance(2, outside, "10"),
          feeBalance(3, outside, "90"),
        ],
      })
    );

    expect(others).toEqual([]);
    expect(observed?.row).toMatchObject({ direction: "outbound", amount: "0.0001" });
    expect(observed?.movement.amounts).toEqual({ debit: 100n, fee: 0n, credit: 100n });
    expect(observed?.movement.verification).toEqual({
      state: "verified",
      reason: "chain_delta_matched",
    });
  });

  it("flags a stated fee the balance change contradicts, and never reads the display string", async () => {
    const [observed] = await observe(
      tokenTransaction(token2022Transfer("transferCheckedWithFee", "1000000", "5000"), "900000")
    );

    expect(observed?.row.amount).toBe("0.995");
    expect(observed?.movement.verification).toEqual({
      state: "mismatch",
      reason: "chain_delta_mismatch",
    });
  });

  it("moves native SOL as the native asset, verified by the lamport change", async () => {
    const [matched] = await observe(solTransaction(1_500_000_000, 1_500_000_000));
    expect(matched?.row).toMatchObject({ token: SOL_MINT, amount: "1.5", direction: "inbound" });
    expect(matched?.movement).toMatchObject({
      asset: { kind: "native" },
      basis: "credit",
      decimals: 9,
      verification: { state: "verified" },
    });

    clearObservedTransferCaches();
    const [short] = await observe(solTransaction(1_500_000_000, 1_000_000_000));
    expect(short?.movement.verification.state).toBe("mismatch");
  });

  it("moves the wrapped SOL mint as an SPL token, not as native SOL", async () => {
    const wrapped = (accountIndex: number, owner: string, amount: string) =>
      parsedTokenBalance({
        accountIndex,
        mint: SOL_MINT,
        owner,
        tokenAmount: { amount, decimals: 9, uiAmountString: "0" },
      });
    const [observed] = await observe(
      parsedTransactionResult({
        signature: "1".repeat(64),
        slot: 50,
        blockTime: 1700000000,
        accountKeys: [SENDER, SOURCE_TOKEN_ACCOUNT, WALLET_TOKEN_ACCOUNT],
        instructions: [
          parsedTransferChecked({
            source: SOURCE_TOKEN_ACCOUNT,
            destination: WALLET_TOKEN_ACCOUNT,
            mint: SOL_MINT,
            authority: SENDER,
            tokenAmount: { amount: "2000000000", decimals: 9, uiAmountString: "2" },
          }),
        ],
        innerInstructions: [],
        preTokenBalances: [wrapped(1, SENDER, "2000000000"), wrapped(2, WALLET, "0")],
        postTokenBalances: [wrapped(1, SENDER, "0"), wrapped(2, WALLET, "2000000000")],
      })
    );

    expect(observed?.row.token).toBe(SOL_MINT);
    expect(observed?.movement.asset).toEqual({
      kind: "token",
      mint: SOL_MINT,
      program: "spl-token",
    });
    expect(observed?.movement.verification.state).toBe("verified");
  });

  it("reads one getTransaction per signature and nothing else", async () => {
    await observe(
      tokenTransaction(token2022Transfer("transferCheckedWithFee", "1000000", "5000"), "995000")
    );
    expect(
      rpc.calls.map((call) => call.method).filter((method) => method !== "getGenesisHash")
    ).toEqual(["getTransaction"]);
  });
});
