import { runInClusterScope } from "@sdp/rpc/scope";
import type { SignatureInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClusterRpcReply, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import {
  parsedSystemTransfer,
  parsedTransactionResult,
  signatureHistoryEntry,
  syntheticAddress,
} from "@/test/helpers/parsed-transactions";
import {
  buildObservedTransfersForSignatures,
  clearObservedTransferCaches,
  PARSED_TRANSACTION_CACHE_MAX_ENTRIES,
} from "./observed-transfers";

const PAYER = syntheticAddress(1);
const WALLET_ADDRESS = syntheticAddress(2);

const context = {
  organizationId: "org_cache_test",
  projectId: "prj_cache_test",
  walletIdsByAddress: new Map([[WALLET_ADDRESS, "wal_cache_test"]]),
};

const getTransactionParamsSchema = z.tuple([z.string(), z.unknown()]);

function solTransferReply(requestedSignature: string): ClusterRpcReply {
  return {
    result: parsedTransactionResult({
      signature: requestedSignature,
      slot: 42,
      blockTime: 1700000000,
      accountKeys: [PAYER, WALLET_ADDRESS],
      instructions: [
        parsedSystemTransfer({ source: PAYER, destination: WALLET_ADDRESS, lamports: 1000 }),
      ],
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    }),
  };
}

function buildOn(environment: SdpEnvironment, signatures: SignatureInfo[]) {
  return runInClusterScope({ projectId: null, environment }, () =>
    buildObservedTransfersForSignatures(signatures, context)
  );
}

describe("observed-transfers parsed-transaction cache", () => {
  const rpc = installClusterRpcResponder();

  function respondTransactions(
    reply: (attempt: number, requestedSignature: string) => ClusterRpcReply
  ) {
    let attempt = 0;
    rpc.respond("getTransaction", (request) => {
      attempt += 1;
      return reply(attempt, getTransactionParamsSchema.parse(request.params)[0]);
    });
  }

  function transactionReads() {
    return rpc.calls.filter((call) => call.method === "getTransaction");
  }

  beforeEach(() => {
    clearObservedTransferCaches();
  });

  it("serves repeat reads of immutable transaction bodies from cache", async () => {
    respondTransactions((_attempt, requestedSignature) => solTransferReply(requestedSignature));

    const signatures = [
      signatureHistoryEntry(0, "finalized"),
      signatureHistoryEntry(1, "finalized"),
      signatureHistoryEntry(2, "finalized"),
    ];
    const first = await buildOn("sandbox", signatures);
    const second = await buildOn("sandbox", signatures);

    expect(transactionReads()).toHaveLength(3);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  it("never serves one cluster's finalized body for the same signature on another cluster", async () => {
    rpc.respond("getTransaction", (request) =>
      request.cluster === "devnet"
        ? solTransferReply(getTransactionParamsSchema.parse(request.params)[0])
        : { result: null }
    );

    const signatures = [signatureHistoryEntry(0, "finalized")];
    const devnetRows = await buildOn("sandbox", signatures);
    const mainnetRows = await buildOn("production", signatures);

    expect(transactionReads()).toEqual([
      { cluster: "devnet", method: "getTransaction" },
      { cluster: "mainnet-beta", method: "getTransaction" },
    ]);
    expect(devnetRows).toHaveLength(1);
    expect(mainnetRows).toEqual([]);
  });

  it("uses fresh signature-history slot and blockTime instead of cached RPC metadata", async () => {
    respondTransactions((_attempt, requestedSignature) => solTransferReply(requestedSignature));

    const [first] = await buildOn("sandbox", [
      { ...signatureHistoryEntry(0, "finalized"), slot: 777n, blockTime: 1800000000n },
    ]);

    expect(first?.slot).toBe(777);
    expect(first?.block_time).toBe(new Date(1800000000 * 1_000).toISOString());

    const [second] = await buildOn("sandbox", [
      { ...signatureHistoryEntry(0, "finalized"), slot: 778n, blockTime: 1800000100n },
    ]);

    expect(transactionReads()).toHaveLength(1);
    expect(second?.slot).toBe(778);
    expect(second?.block_time).toBe(new Date(1800000100 * 1_000).toISOString());
  });

  it("coalesces concurrent fetches for the same signature", async () => {
    respondTransactions((_attempt, requestedSignature) => solTransferReply(requestedSignature));

    const signatures = [signatureHistoryEntry(0, "finalized")];
    const [first, second] = await Promise.all([
      buildOn("sandbox", signatures),
      buildOn("sandbox", signatures),
    ]);

    expect(transactionReads()).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it("does not cache confirmed-but-not-finalized results until the history reports finality", async () => {
    respondTransactions((_attempt, requestedSignature) => solTransferReply(requestedSignature));

    await buildOn("sandbox", [signatureHistoryEntry(0, "confirmed")]);
    const second = await buildOn("sandbox", [signatureHistoryEntry(0, "confirmed")]);
    expect(transactionReads()).toHaveLength(2);
    expect(second).toHaveLength(1);

    const third = await buildOn("sandbox", [signatureHistoryEntry(0, "finalized")]);
    expect(transactionReads()).toHaveLength(3);
    expect(third).toHaveLength(1);

    const fourth = await buildOn("sandbox", [signatureHistoryEntry(0, "finalized")]);
    expect(transactionReads()).toHaveLength(3);
    expect(fourth).toEqual(third);
  });

  it("does not cache null results so a just-submitted transfer appears as soon as the chain indexes it", async () => {
    respondTransactions((attempt, requestedSignature) =>
      attempt === 1 ? { result: null } : solTransferReply(requestedSignature)
    );

    const signatures = [signatureHistoryEntry(0, "finalized")];
    const beforeIndexed = await buildOn("sandbox", signatures);
    const afterIndexed = await buildOn("sandbox", signatures);

    expect(transactionReads()).toHaveLength(2);
    expect(beforeIndexed).toEqual([]);
    expect(afterIndexed).toHaveLength(1);
    expect(afterIndexed[0]?.status).toBe("confirmed");
  });

  it("does not cache RPC failures so the next read retries", async () => {
    respondTransactions((attempt, requestedSignature) =>
      attempt === 1
        ? { error: { code: SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, message: "upstream boom" } }
        : solTransferReply(requestedSignature)
    );

    const signatures = [signatureHistoryEntry(0, "finalized")];
    const first = await buildOn("sandbox", signatures);
    const second = await buildOn("sandbox", signatures);

    expect(transactionReads()).toHaveLength(2);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it("evicts the oldest entry once the cache exceeds its cap", async () => {
    respondTransactions((_attempt, requestedSignature) => solTransferReply(requestedSignature));

    const allSignatures = Array.from(
      { length: PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1 },
      (_, index) => signatureHistoryEntry(index, "finalized")
    );
    await buildOn("sandbox", allSignatures);
    expect(transactionReads()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1);

    await buildOn("sandbox", [signatureHistoryEntry(0, "finalized")]);
    expect(transactionReads()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);

    await buildOn("sandbox", [
      signatureHistoryEntry(PARSED_TRANSACTION_CACHE_MAX_ENTRIES, "finalized"),
    ]);
    expect(transactionReads()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);
  });
});
