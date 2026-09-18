import type { Signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
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

function signatureEntry(index: number) {
  return {
    signature: `sig_${index}` as unknown as Signature,
    slot: BigInt(index),
    blockTime: 1700000000n,
    err: null,
  };
}

function parsedSolTransfer(lamports: string) {
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

function jsonRpcResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("observed-transfers parsed-transaction cache", () => {
  beforeEach(() => {
    clearObservedTransferCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves repeat reads of immutable transaction bodies from cache", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    const signatures = [signatureEntry(0), signatureEntry(1), signatureEntry(2)];
    const first = await buildObservedTransfersForSignatures(env, signatures, context);
    const second = await buildObservedTransfersForSignatures(env, signatures, context);

    expect(fetchCount).toBe(3);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  it("coalesces concurrent fetches for the same signature", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    const signatures = [signatureEntry(0)];
    const [first, second] = await Promise.all([
      buildObservedTransfersForSignatures(env, signatures, context),
      buildObservedTransfersForSignatures(env, signatures, context),
    ]);

    expect(fetchCount).toBe(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it("does not cache null results so a just-submitted transfer appears as soon as the chain indexes it", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jsonRpcResponse({ result: null })
        : jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    const signatures = [signatureEntry(0)];
    const beforeIndexed = await buildObservedTransfersForSignatures(env, signatures, context);
    const afterIndexed = await buildObservedTransfersForSignatures(env, signatures, context);

    expect(fetchCount).toBe(2);
    expect(beforeIndexed).toEqual([]);
    expect(afterIndexed).toHaveLength(1);
    expect(afterIndexed[0]?.status).toBe("confirmed");
  });

  it("does not cache RPC failures so the next read retries", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jsonRpcResponse({ error: { message: "upstream boom" } })
        : jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    const signatures = [signatureEntry(0)];
    const first = await buildObservedTransfersForSignatures(env, signatures, context);
    const second = await buildObservedTransfersForSignatures(env, signatures, context);

    expect(fetchCount).toBe(2);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it("evicts the oldest entry once the cache exceeds its cap", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return jsonRpcResponse({ result: { slot: 1 } });
    });

    const allSignatures = Array.from(
      { length: PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1 },
      (_, index) => signatureEntry(index)
    );
    await buildObservedTransfersForSignatures(env, allSignatures, context);
    expect(fetchCount).toBe(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 1);

    // The first signature was evicted to make room for the last one, so it is
    // fetched again; the newest entry is still cached.
    await buildObservedTransfersForSignatures(env, [signatureEntry(0)], context);
    expect(fetchCount).toBe(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);

    await buildObservedTransfersForSignatures(
      env,
      [signatureEntry(PARSED_TRANSACTION_CACHE_MAX_ENTRIES)],
      context
    );
    expect(fetchCount).toBe(PARSED_TRANSACTION_CACHE_MAX_ENTRIES + 2);
  });
});
