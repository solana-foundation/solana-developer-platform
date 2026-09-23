import type { Signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import {
  buildObservedTransfersForSignatures,
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";

describe("buildObservedTransfersForSignatures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds concurrent getTransaction lookups instead of fanning out per signature", async () => {
    let inFlight = 0;
    let peak = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const signatures = Array.from({ length: 25 }, (_, index) => ({
      signature: `sig_${index}` as unknown as Signature,
      slot: BigInt(index),
      blockTime: 1700000000n,
      err: null,
    }));

    const rows = await buildObservedTransfersForSignatures(env, signatures, {
      organizationId: "org_fanout_test",
      projectId: null,
      walletIdsByAddress: new Map([["wallet_address", "wal_fanout_test"]]),
    });

    expect(rows).toEqual([]);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(SIGNATURE_HISTORY_LOOKUP_CONCURRENCY);
  });
});
