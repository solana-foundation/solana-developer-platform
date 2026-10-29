import { runInClusterScope } from "@sdp/rpc/scope";
import { blockhash } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENVIRONMENT_CLUSTER_CASES, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { signWithFreshBlockhash } from "./sign-with-fresh-blockhash";

const hash = blockhash("11111111111111111111111111111111");
afterEach(() => vi.restoreAllMocks());

describe("payment approval lifetime", () => {
  const rpc = installClusterRpcResponder();
  const inSandbox = <T>(operation: () => T) =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, operation);

  it("adds no RPC read for fast signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(20);
    expect(
      await inSandbox(() => signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" }))
    ).toBe("signed");
    expect(rpc.requests).toEqual([]);
  });

  it.each(ENVIRONMENT_CLUSTER_CASES)(
    "checks the exact blockhash once on $cluster after slow approval",
    async ({ environment, cluster }) => {
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
      rpc.answer("isBlockhashValid", { context: { slot: 1 }, value: true });
      expect(
        await runInClusterScope({ projectId: null, environment }, () =>
          signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" })
        )
      ).toBe("signed");
      expect(rpc.requests.filter((request) => request.method === "isBlockhashValid")).toEqual([
        { cluster, method: "isBlockhashValid", params: [hash, { commitment: "confirmed" }] },
      ]);
      expect(rpc.requests.every((request) => request.cluster === cluster)).toBe(true);
    }
  );

  it("refuses expired signatures without retrying custody signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(80_000);
    rpc.answer("isBlockhashValid", { context: { slot: 1 }, value: false });
    const sign = vi.fn(async () => "signed");
    await expect(
      inSandbox(() => signWithFreshBlockhash({ blockhash: hash, sign }))
    ).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message: expect.stringContaining("was not submitted"),
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the lifetime check is unavailable", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    rpc.respond("isBlockhashValid", () => ({
      error: { code: -32603, message: "RPC unavailable" },
    }));
    await expect(
      inSandbox(() => signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" }))
    ).rejects.toThrow("RPC unavailable");
  });

  it("requires an open cluster scope before custody signing", async () => {
    const sign = vi.fn(async () => "signed");
    await expect(signWithFreshBlockhash({ blockhash: hash, sign })).rejects.toMatchObject({
      code: "CLUSTER_SCOPE_MISSING",
    });
    expect(sign).not.toHaveBeenCalled();
    expect(rpc.requests).toEqual([]);
  });
});
