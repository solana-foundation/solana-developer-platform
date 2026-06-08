import type { Signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import { NativeAdapter } from "./native.adapter";

describe("NativeAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves RPC error text when signAndSend fails", async () => {
    const adapter = new NativeAdapter({} as Env);
    vi.spyOn(adapter, "signAsFeePayer").mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValue(new Error("Blockhash not found"));

    await expect(adapter.signAndSend(new Uint8Array([4, 5, 6]))).rejects.toMatchObject({
      code: "SUBMISSION_FAILED",
      message: expect.stringContaining("Blockhash not found"),
    });
  });

  it("returns the submitted signature on success", async () => {
    const adapter = new NativeAdapter({} as Env);
    vi.spyOn(adapter, "signAsFeePayer").mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue("4mock" as Signature);

    await expect(adapter.signAndSend(new Uint8Array([4, 5, 6]))).resolves.toBe("4mock");
  });
});
