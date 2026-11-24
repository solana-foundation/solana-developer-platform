import { blockhash } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inSandboxScope, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { signWithFreshBlockhash } from "./sign-with-fresh-blockhash";

const hash = blockhash("11111111111111111111111111111111");
afterEach(() => vi.restoreAllMocks());

describe("payment approval lifetime", () => {
  const rpc = installClusterRpcResponder();

  it("adds no RPC read for fast signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(20);
    expect(
      await inSandboxScope(() =>
        signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" })
      )
    ).toBe("signed");
    expect(rpc.requests).toEqual([]);
  });

  it("checks the exact blockhash once after slow approval", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    rpc.answer("isBlockhashValid", { context: { slot: 1 }, value: true });
    expect(
      await inSandboxScope(() =>
        signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" })
      )
    ).toBe("signed");
    expect(rpc.requests.filter((request) => request.method === "isBlockhashValid")).toEqual([
      {
        cluster: "devnet",
        method: "isBlockhashValid",
        params: [hash, { commitment: "confirmed" }],
      },
    ]);
  });

  it("refuses expired signatures without retrying custody signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(80_000);
    rpc.answer("isBlockhashValid", { context: { slot: 1 }, value: false });
    const sign = vi.fn(async () => "signed");
    await expect(
      inSandboxScope(() => signWithFreshBlockhash({ blockhash: hash, sign }))
    ).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message:
        "This transaction expired while waiting for custody approval and was not submitted. Review payment status before creating another payment.",
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the lifetime check is unavailable", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    rpc.respond("isBlockhashValid", () => ({
      error: { code: -32603, message: "RPC unavailable" },
    }));
    await expect(
      inSandboxScope(() => signWithFreshBlockhash({ blockhash: hash, sign: async () => "signed" }))
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
