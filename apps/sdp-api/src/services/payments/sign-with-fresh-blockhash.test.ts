import { isBlockhashValid, type SolanaRpc } from "@sdp/rpc/solana";
import { blockhash } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signWithFreshBlockhash } from "./sign-with-fresh-blockhash";

vi.mock("@sdp/rpc/solana", () => ({ isBlockhashValid: vi.fn() }));
const rpc = {} as SolanaRpc;
const hash = blockhash("11111111111111111111111111111111");
afterEach(() => vi.restoreAllMocks());

describe("payment approval lifetime", () => {
  it("adds no RPC read for fast signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(20);
    vi.mocked(isBlockhashValid).mockClear();
    expect(await signWithFreshBlockhash({ rpc, blockhash: hash, sign: async () => "signed" })).toBe(
      "signed"
    );
    expect(isBlockhashValid).not.toHaveBeenCalled();
  });

  it("checks the exact blockhash once after slow approval", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    vi.mocked(isBlockhashValid).mockReset().mockResolvedValue(true);
    expect(await signWithFreshBlockhash({ rpc, blockhash: hash, sign: async () => "signed" })).toBe(
      "signed"
    );
    expect(isBlockhashValid).toHaveBeenCalledExactlyOnceWith(rpc, hash, "confirmed");
  });

  it("refuses expired signatures without retrying custody signing", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(80_000);
    vi.mocked(isBlockhashValid).mockReset().mockResolvedValue(false);
    const sign = vi.fn(async () => "signed");
    await expect(signWithFreshBlockhash({ rpc, blockhash: hash, sign })).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message: expect.stringContaining("was not submitted"),
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the lifetime check is unavailable", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_000);
    vi.mocked(isBlockhashValid).mockReset().mockRejectedValue(new Error("RPC unavailable"));
    await expect(
      signWithFreshBlockhash({ rpc, blockhash: hash, sign: async () => "signed" })
    ).rejects.toThrow("RPC unavailable");
  });
});
