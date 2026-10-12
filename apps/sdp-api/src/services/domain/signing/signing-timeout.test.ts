import { SigningError } from "@sdp/custody/signing";
import type { TransactionSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { boundSigningTime } from "./signing-timeout";

describe("boundSigningTime", () => {
  it("fails a signing call that outlives the bound, as a retryable network error", async () => {
    vi.useFakeTimers();
    try {
      const signer = {
        address: "Signer111111111111111111111111111111111111",
        signTransactions: vi.fn(() => new Promise<never>(() => undefined)),
      } as unknown as TransactionSigner;
      const signing = (
        boundSigningTime(signer, 1_000) as unknown as { signTransactions(): Promise<unknown> }
      ).signTransactions();
      const settled = expect(signing).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;
      await expect(signing).rejects.toBeInstanceOf(SigningError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps everything it does not bound, including a sending method on the prototype", async () => {
    class SendingSigner {
      readonly address = "Signer111111111111111111111111111111111111";
      signTransactions = vi.fn(async () => ["signed"]);
      signAndSendTransactions(): Promise<string[]> {
        return Promise.resolve(["sent"]);
      }
    }
    const original = new SendingSigner();
    const bounded = boundSigningTime(
      original as unknown as TransactionSigner
    ) as unknown as SendingSigner;

    expect(bounded.address).toBe(original.address);
    expect(await bounded.signTransactions()).toEqual(["signed"]);
    expect(bounded.signAndSendTransactions).toBe(original.signAndSendTransactions);
    expect(await bounded.signAndSendTransactions()).toEqual(["sent"]);
  });
});
