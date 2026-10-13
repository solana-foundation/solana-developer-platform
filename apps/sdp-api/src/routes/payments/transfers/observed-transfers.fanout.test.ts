import { runInClusterScope } from "@sdp/rpc/scope";
import type { Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import {
  buildObservedTransfersForSignatures,
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";

describe("buildObservedTransfersForSignatures", () => {
  const rpc = installClusterRpcStub();

  it("bounds concurrent getTransaction lookups instead of fanning out per signature", async () => {
    rpc.answer("getTransaction", null);
    let inFlight = 0;
    let peak = 0;
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await stubbedFetch(input, init);
      } finally {
        inFlight -= 1;
      }
    };

    const signatures = Array.from({ length: 25 }, (_, index) => ({
      signature: `sig_${index}` as unknown as Signature,
      slot: BigInt(index),
      blockTime: 1700000000n,
      err: null,
    }));

    const rows = await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      buildObservedTransfersForSignatures(signatures, {
        organizationId: "org_fanout_test",
        projectId: null,
        walletIdsByAddress: new Map([["wallet_address", "wal_fanout_test"]]),
      })
    );

    expect(rows).toEqual([]);
    expect(rpc.calls.filter((call) => call.method === "getTransaction")).toHaveLength(25);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(SIGNATURE_HISTORY_LOOKUP_CONCURRENCY);
  });
});
