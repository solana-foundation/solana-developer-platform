import { SigningError } from "@sdp/custody/signing";
import {
  address,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionPartialSigner,
  type TransactionSendingSigner,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  boundSigningTime,
  CUSTODY_SIGNING_TIMEOUT_MS,
  custodySigningTimeoutMs,
} from "./signing-timeout";

const SIGNER_ADDRESS = address("11111111111111111111111111111111");

describe("boundSigningTime", () => {
  it("fails a signing call that outlives the bound, as a retryable network error", async () => {
    vi.useFakeTimers();
    try {
      const signer: TransactionPartialSigner = {
        address: SIGNER_ADDRESS,
        signTransactions: vi.fn(() => new Promise<never>(() => undefined)),
      };
      const bounded = boundSigningTime(signer, 1_000);
      if (!isTransactionPartialSigner(bounded)) {
        throw new Error("the bounded signer lost signTransactions");
      }
      const signing = bounded.signTransactions([]);
      const settled = expect(signing).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;
      await expect(signing).rejects.toBeInstanceOf(SigningError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps everything it does not bound, including a sending method on the prototype", async () => {
    const signed: readonly SignatureDictionary[] = [];
    const sent: readonly SignatureBytes[] = [];
    class SendingSigner implements TransactionPartialSigner, TransactionSendingSigner {
      readonly address = SIGNER_ADDRESS;
      signTransactions = vi.fn(async () => signed);
      signAndSendTransactions(): Promise<readonly SignatureBytes[]> {
        return Promise.resolve(sent);
      }
    }
    const original = new SendingSigner();
    const bounded = boundSigningTime(original);
    if (!isTransactionPartialSigner(bounded) || !isTransactionSendingSigner(bounded)) {
      throw new Error("the bounded signer lost a signing method");
    }

    expect(bounded.address).toBe(original.address);
    expect(await bounded.signTransactions([])).toBe(signed);
    expect(original.signTransactions).toHaveBeenCalledOnce();
    expect(bounded.signAndSendTransactions).toBe(original.signAndSendTransactions);
    expect(await bounded.signAndSendTransactions([])).toBe(sent);
  });
});

describe("custodySigningTimeoutMs", () => {
  it("covers the default poll budget, and a longer configured Utila budget, with a margin", () => {
    const defaultBound = custodySigningTimeoutMs({});
    expect(defaultBound).toBeGreaterThan(60 * 1_000);
    expect(defaultBound).toBeGreaterThanOrEqual(CUSTODY_SIGNING_TIMEOUT_MS);

    const longBudget = custodySigningTimeoutMs({
      UTILA_POLL_INTERVAL_MS: "2000",
      UTILA_MAX_POLL_ATTEMPTS: "90",
    });
    expect(longBudget).toBeGreaterThan(180_000);
  });

  it("never drops below the base bound for a short budget", () => {
    expect(
      custodySigningTimeoutMs({ UTILA_POLL_INTERVAL_MS: "100", UTILA_MAX_POLL_ATTEMPTS: "5" })
    ).toBeGreaterThanOrEqual(CUSTODY_SIGNING_TIMEOUT_MS);
  });
});
