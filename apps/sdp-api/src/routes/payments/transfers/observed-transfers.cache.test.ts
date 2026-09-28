import { formatDecimalAmount } from "@sdp/solana/amount";
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

function signatureEntry(
  index: number,
  confirmationStatus: "confirmed" | "finalized" = "finalized"
) {
  return {
    signature: `sig_${index}` as unknown as Signature,
    slot: BigInt(index),
    blockTime: 1700000000n,
    err: null,
    confirmationStatus,
  };
}

function parsedSolTransfer(lamports: string) {
  // Mirrors a real getTransaction response: there is no finality field on the
  // body, so caching decisions must come from the signature history instead.
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

  it("uses fresh signature-history slot and blockTime instead of cached RPC metadata", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      // Body was confirmed in slot 42 at blockTime 1700000000.
      return jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    // First read: the signature history reports the transaction landing in
    // slot 777 at blockTime 1800000000, so those fresh values must win over
    // the cached body's fork-sensitive copy.
    const [first] = await buildObservedTransfersForSignatures(
      env,
      [
        {
          signature: "sig_0" as unknown as Signature,
          slot: 777n,
          blockTime: 1800000000n,
          err: null,
          confirmationStatus: "finalized",
        },
      ],
      context
    );

    expect(first?.slot).toBe(777);
    expect(first?.block_time).toBe(new Date(1800000000 * 1_000).toISOString());

    // Second read: the body is served from cache (no extra fetch), but a new
    // history entry reflecting a fork re-landing the signature in a different
    // slot must still take effect.
    const [second] = await buildObservedTransfersForSignatures(
      env,
      [
        {
          signature: "sig_0" as unknown as Signature,
          slot: 778n,
          blockTime: 1800000100n,
          err: null,
          confirmationStatus: "finalized",
        },
      ],
      context
    );

    expect(fetchCount).toBe(1);
    expect(second?.slot).toBe(778);
    expect(second?.block_time).toBe(new Date(1800000100 * 1_000).toISOString());
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

  it("does not cache confirmed-but-not-finalized results until the history reports finality", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      // Same signature observed twice on different fork branches before it
      // roots: first with 1000 lamports, then re-landed with 2000. A cached
      // body would serve the stale amount forever.
      return jsonRpcResponse({
        result: parsedSolTransfer(fetchCount === 1 ? "1000" : "2000"),
      });
    });

    const signatures = [signatureEntry(0)];

    // While the fresh history still reports "confirmed", every read refetches
    // and sees whatever branch the confirmed ledger currently reports.
    const first = await buildObservedTransfersForSignatures(
      env,
      [signatureEntry(0, "confirmed")],
      context
    );
    const confirmedEntry = [{ ...signatureEntry(0, "confirmed") }];
    const second = await buildObservedTransfersForSignatures(env, confirmedEntry, context);
    expect(fetchCount).toBe(2);
    expect(first[0]?.amount).toBe(formatDecimalAmount(1000n, 9));
    expect(second[0]?.amount).toBe(formatDecimalAmount(2000n, 9));

    // Once the fresh history reports "finalized", the body is immutable: it
    // is fetched once more, then cached.
    const third = await buildObservedTransfersForSignatures(
      env,
      [signatureEntry(0, "finalized")],
      context
    );
    expect(fetchCount).toBe(3);
    expect(third).toHaveLength(1);

    const fourth = await buildObservedTransfersForSignatures(env, signatures, context);
    expect(fetchCount).toBe(3);
    expect(fourth).toEqual(third);
  });

  it("never caches when the history entry carries no confirmation status", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      return jsonRpcResponse({ result: parsedSolTransfer("1000") });
    });

    // Finality is unknown — treat as not finalized and refetch every read.
    const signatures = [
      {
        signature: "sig_0" as unknown as Signature,
        slot: 0n,
        blockTime: 1700000000n,
        err: null,
      },
    ];
    const first = await buildObservedTransfersForSignatures(env, signatures, context);
    const second = await buildObservedTransfersForSignatures(env, signatures, context);

    expect(fetchCount).toBe(2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
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
