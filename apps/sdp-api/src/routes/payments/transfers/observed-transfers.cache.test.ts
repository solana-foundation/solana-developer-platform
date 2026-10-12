import { runInClusterScope } from "@sdp/rpc/scope";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { type SdpEnvironment, SOL_MINT } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import {
  buildObservedTransfersForSignatures,
  clearObservedTransferCaches,
  PARSED_TRANSACTION_CACHE_MAX_ENTRIES,
} from "./observed-transfers";

const PAYER = "payer_address";
const WALLET_ADDRESS = "wallet_address";

const context = {
  organizationId: "org_cache_test",
  projectId: null,
  walletIdsByAddress: new Map([[WALLET_ADDRESS, "wal_cache_test"]]),
};

function signatureEntry(index: number, confirmationStatus: "confirmed" | "finalized") {
  return {
    signature: `sig_${index}` as unknown as Signature,
    slot: BigInt(index),
    blockTime: 1700000000n,
    err: null,
    confirmationStatus,
  };
}

function parsedSolTransfer(lamports: string | number) {
  return {
    slot: 42,
    blockTime: 1700000000,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      postBalances: [],
      postTokenBalances: [],
      preBalances: [],
      preTokenBalances: [],
    },
    transaction: {
      message: {
        accountKeys: [PAYER, WALLET_ADDRESS],
        instructions: [
          {
            program: "system",
            parsed: {
              type: "transfer",
              info: { source: PAYER, destination: WALLET_ADDRESS, lamports },
            },
          },
        ],
      },
    },
  };
}

function buildInScope(
  environment: SdpEnvironment,
  signatures: Parameters<typeof buildObservedTransfersForSignatures>[0]
) {
  return runInClusterScope({ projectId: null, environment }, () =>
    buildObservedTransfersForSignatures(signatures, context)
  );
}

function buildOnDevnet(signatures: Parameters<typeof buildObservedTransfersForSignatures>[0]) {
  return buildInScope("sandbox", signatures);
}

describe("observed-transfers parsed-transaction cache", () => {
  const rpc = installClusterRpcStub();

  function getTransactionCalls() {
    return rpc.calls.filter((call) => call.method === "getTransaction");
  }

  beforeEach(() => {
    clearObservedTransferCaches();
  });

  it("serves repeat reads of immutable transaction bodies from cache", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    const signatures = [
      signatureEntry(0, "finalized"),
      signatureEntry(1, "finalized"),
      signatureEntry(2, "finalized"),
    ];
    const first = await buildOnDevnet(signatures);
    const second = await buildOnDevnet(signatures);

    expect(getTransactionCalls()).toHaveLength(3);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  it("uses fresh signature-history slot and blockTime instead of cached RPC metadata", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    const [first] = await buildOnDevnet([
      {
        signature: "sig_0" as unknown as Signature,
        slot: 777n,
        blockTime: 1800000000n,
        err: null,
        confirmationStatus: "finalized",
      },
    ]);

    expect(first?.slot).toBe(777);
    expect(first?.block_time).toBe(new Date(1800000000 * 1_000).toISOString());

    const [second] = await buildOnDevnet([
      {
        signature: "sig_0" as unknown as Signature,
        slot: 778n,
        blockTime: 1800000100n,
        err: null,
        confirmationStatus: "finalized",
      },
    ]);

    expect(getTransactionCalls()).toHaveLength(1);
    expect(second?.slot).toBe(778);
    expect(second?.block_time).toBe(new Date(1800000100 * 1_000).toISOString());
  });

  it("coalesces concurrent fetches for the same signature", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    const signatures = [signatureEntry(0, "finalized")];
    const [first, second] = await Promise.all([
      buildOnDevnet(signatures),
      buildOnDevnet(signatures),
    ]);

    expect(getTransactionCalls()).toHaveLength(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it("fetches the same signature's body separately per cluster, cached and in flight", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    await buildInScope("sandbox", [signatureEntry(0, "finalized")]);
    await buildInScope("production", [signatureEntry(0, "finalized")]);
    await Promise.all([
      buildInScope("sandbox", [signatureEntry(1, "finalized")]),
      buildInScope("production", [signatureEntry(1, "finalized")]),
    ]);

    const clusters = getTransactionCalls().map((call) => call.cluster);
    expect(clusters.slice(0, 2)).toEqual(["devnet", "mainnet-beta"]);
    expect(clusters.slice(2).sort()).toEqual(["devnet", "mainnet-beta"]);

    await buildInScope("sandbox", [signatureEntry(0, "finalized")]);
    await buildInScope("production", [signatureEntry(1, "finalized")]);

    expect(getTransactionCalls()).toHaveLength(4);
  });

  it("turns a system transfer whose lamports kit decodes as a bigint into the SOL row", async () => {
    rpc.answer("getTransaction", parsedSolTransfer(1_500_000_000));

    const timestamp = new Date(1700000000 * 1_000).toISOString();

    expect(await buildOnDevnet([signatureEntry(7, "finalized")])).toEqual([
      {
        id: "xfr_observed_wal_cache_test_sig_7",
        organization_id: "org_cache_test",
        project_id: null,
        wallet_id: "wal_cache_test",
        custody_wallet_id: null,
        counterparty_id: null,
        source_address: PAYER,
        destination_address: WALLET_ADDRESS,
        token: SOL_MINT,
        amount: formatDecimalAmount(1_500_000_000n, 9),
        memo: null,
        type: "transfer",
        kind: "deposit",
        direction: "inbound",
        status: "confirmed",
        provider: null,
        provider_reference: null,
        delivery_mode: null,
        fiat_currency: null,
        fiat_amount: null,
        ramps_memo: {},
        provider_data: {},
        signature: "sig_7",
        serialized_tx: null,
        signed_transaction: null,
        last_valid_block_height: null,
        submission_started_at: null,
        slot: 7,
        block_time: timestamp,
        fee: 5000,
        error: null,
        initiated_by_key_id: null,
        idempotency_key: null,
        idempotency_fingerprint: null,
        confirmed_at: null,
        finalization_last_polled_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ]);
  });

  it("does not cache confirmed-but-not-finalized results until the history reports finality", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));
    const first = await buildOnDevnet([signatureEntry(0, "confirmed")]);
    rpc.answer("getTransaction", parsedSolTransfer("2000"));
    const second = await buildOnDevnet([signatureEntry(0, "confirmed")]);
    expect(getTransactionCalls()).toHaveLength(2);
    expect(first[0]?.amount).toBe(formatDecimalAmount(1000n, 9));
    expect(second[0]?.amount).toBe(formatDecimalAmount(2000n, 9));

    const third = await buildOnDevnet([signatureEntry(0, "finalized")]);
    expect(getTransactionCalls()).toHaveLength(3);
    expect(third).toHaveLength(1);

    const fourth = await buildOnDevnet([signatureEntry(0, "finalized")]);
    expect(getTransactionCalls()).toHaveLength(3);
    expect(fourth).toEqual(third);
  });

  it("never caches when the history entry carries no confirmation status", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    const signatures = [
      {
        signature: "sig_0" as unknown as Signature,
        slot: 0n,
        blockTime: 1700000000n,
        err: null,
      },
    ];
    const first = await buildOnDevnet(signatures);
    const second = await buildOnDevnet(signatures);

    expect(getTransactionCalls()).toHaveLength(2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("does not cache null results so a just-submitted transfer appears as soon as the chain indexes it", async () => {
    const signatures = [signatureEntry(0, "finalized")];
    rpc.answer("getTransaction", null);
    const beforeIndexed = await buildOnDevnet(signatures);
    rpc.answer("getTransaction", parsedSolTransfer("1000"));
    const afterIndexed = await buildOnDevnet(signatures);

    expect(getTransactionCalls()).toHaveLength(2);
    expect(beforeIndexed).toEqual([]);
    expect(afterIndexed).toHaveLength(1);
    expect(afterIndexed[0]?.status).toBe("confirmed");
  });

  it("does not cache RPC failures so the next read retries", async () => {
    const signatures = [signatureEntry(0, "finalized")];
    const first = await buildOnDevnet(signatures);
    rpc.answer("getTransaction", parsedSolTransfer("1000"));
    const second = await buildOnDevnet(signatures);

    expect(getTransactionCalls()).toHaveLength(2);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it("evicts the oldest entry once the cache exceeds its cap", async () => {
    rpc.answer("getTransaction", parsedSolTransfer("1000"));

    const allSignatures = Array.from(
      { length: PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1 },
      (_, index) => signatureEntry(index, "finalized")
    );
    await buildOnDevnet(allSignatures);
    expect(getTransactionCalls()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1);

    await buildOnDevnet([signatureEntry(0, "finalized")]);
    expect(getTransactionCalls()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);

    await buildOnDevnet([signatureEntry(PARSED_TRANSACTION_CACHE_MAX_ENTRIES, "finalized")]);
    expect(getTransactionCalls()).toHaveLength(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);
  });
});
