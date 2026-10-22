import { runInClusterScope } from "@sdp/rpc/scope";
import type { SignatureInfo } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
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
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";

const PAYER = syntheticAddress(1);
const WALLET_ADDRESS = syntheticAddress(2);
const SOURCE_TOKEN_ACCOUNT = syntheticAddress(3);
const DESTINATION_TOKEN_ACCOUNT = syntheticAddress(4);
const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

const context = {
  organizationId: "org_fanout_test",
  projectId: "prj_fanout_test",
  walletIdsByAddress: new Map([[WALLET_ADDRESS, "wal_fanout_test"]]),
};

function tokenBalance(accountIndex: number, owner: string, amount: string) {
  return parsedTokenBalance({
    accountIndex,
    mint: USDC_MINT,
    owner,
    tokenAmount: { amount, decimals: 6, uiAmountString: formatDecimalAmount(BigInt(amount), 6) },
  });
}

function buildOnSandbox(signatures: SignatureInfo[]) {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    buildObservedTransfersForSignatures(signatures, context)
  );
}

describe("buildObservedTransfersForSignatures", () => {
  const rpc = installClusterRpcStub();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds concurrent getTransaction lookups instead of fanning out per signature", async () => {
    rpc.answer("getTransaction", null);
    const stubbedFetch = globalThis.fetch;
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await stubbedFetch(input, init);
      } finally {
        inFlight -= 1;
      }
    });

    const rows = await buildOnSandbox(
      Array.from({ length: 25 }, (_, index) => signatureHistoryEntry(index, "confirmed"))
    );

    expect(rows).toEqual([]);
    expect(rpc.calls.filter((call) => call.method === "getTransaction")).toHaveLength(25);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(SIGNATURE_HISTORY_LOOKUP_CONCURRENCY);
  });

  it("reads the integer lamports and transferChecked decimals kit parses to bigint", async () => {
    const observed = signatureHistoryEntry(0, "confirmed");
    rpc.answer(
      "getTransaction",
      parsedTransactionResult({
        signature: observed.signature,
        slot: 42,
        blockTime: 1700000000,
        accountKeys: [PAYER, WALLET_ADDRESS, SOURCE_TOKEN_ACCOUNT, DESTINATION_TOKEN_ACCOUNT],
        instructions: [
          parsedSystemTransfer({ source: PAYER, destination: WALLET_ADDRESS, lamports: 1_500_000 }),
          parsedTransferChecked({
            source: SOURCE_TOKEN_ACCOUNT,
            destination: DESTINATION_TOKEN_ACCOUNT,
            mint: USDC_MINT,
            authority: PAYER,
            tokenAmount: { amount: "2500000", decimals: 6, uiAmountString: "2.5" },
          }),
        ],
        innerInstructions: [],
        preTokenBalances: [tokenBalance(2, PAYER, "2500000"), tokenBalance(3, WALLET_ADDRESS, "0")],
        postTokenBalances: [
          tokenBalance(2, PAYER, "0"),
          tokenBalance(3, WALLET_ADDRESS, "2500000"),
        ],
      })
    );

    const rows = await buildOnSandbox([observed]);

    expect(
      rows.map((row) => ({
        token: row.token,
        amount: row.amount,
        direction: row.direction,
        source: row.source_address,
        destination: row.destination_address,
        fee: row.fee,
      }))
    ).toEqual([
      {
        token: SOL_MINT,
        amount: formatDecimalAmount(1_500_000n, 9),
        direction: "inbound",
        source: PAYER,
        destination: WALLET_ADDRESS,
        fee: 5000,
      },
      {
        token: USDC_MINT,
        amount: "2.5",
        direction: "inbound",
        source: PAYER,
        destination: WALLET_ADDRESS,
        fee: 5000,
      },
    ]);
  });

  it("keeps two equal SOL transfers in one transaction as one row each", async () => {
    const observed = signatureHistoryEntry(0, "confirmed");
    const deposit = parsedSystemTransfer({
      source: PAYER,
      destination: WALLET_ADDRESS,
      lamports: 1_000_000,
    });
    rpc.answer(
      "getTransaction",
      parsedTransactionResult({
        signature: observed.signature,
        slot: 42,
        blockTime: 1700000000,
        accountKeys: [PAYER, WALLET_ADDRESS],
        instructions: [deposit, deposit],
        innerInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      })
    );

    const rows = await buildOnSandbox([observed]);

    expect(rows.map((row) => ({ id: row.id, amount: row.amount }))).toEqual([
      {
        id: `xfr_observed_wal_fanout_test_${observed.signature}_0_inbound`,
        amount: formatDecimalAmount(1_000_000n, 9),
      },
      {
        id: `xfr_observed_wal_fanout_test_${observed.signature}_1_inbound`,
        amount: formatDecimalAmount(1_000_000n, 9),
      },
    ]);
  });

  it("keeps an inner token transfer apart from an equal outer one", async () => {
    const observed = signatureHistoryEntry(0, "confirmed");
    const cpiProgram = syntheticAddress(5);
    const deposit = parsedTransferChecked({
      source: SOURCE_TOKEN_ACCOUNT,
      destination: DESTINATION_TOKEN_ACCOUNT,
      mint: USDC_MINT,
      authority: PAYER,
      tokenAmount: { amount: "2500000", decimals: 6, uiAmountString: "2.5" },
    });
    rpc.answer(
      "getTransaction",
      parsedTransactionResult({
        signature: observed.signature,
        slot: 42,
        blockTime: 1700000000,
        accountKeys: [
          PAYER,
          WALLET_ADDRESS,
          SOURCE_TOKEN_ACCOUNT,
          DESTINATION_TOKEN_ACCOUNT,
          cpiProgram,
        ],
        instructions: [deposit, { programId: cpiProgram, accounts: [], data: "", stackHeight: 1 }],
        innerInstructions: [{ index: 1, instructions: [deposit] }],
        preTokenBalances: [tokenBalance(2, PAYER, "5000000"), tokenBalance(3, WALLET_ADDRESS, "0")],
        postTokenBalances: [
          tokenBalance(2, PAYER, "0"),
          tokenBalance(3, WALLET_ADDRESS, "5000000"),
        ],
      })
    );

    const rows = await buildOnSandbox([observed]);

    expect(rows.map((row) => ({ id: row.id, amount: row.amount }))).toEqual([
      { id: `xfr_observed_wal_fanout_test_${observed.signature}_0_inbound`, amount: "2.5" },
      { id: `xfr_observed_wal_fanout_test_${observed.signature}_1.0_inbound`, amount: "2.5" },
    ]);
  });
});
