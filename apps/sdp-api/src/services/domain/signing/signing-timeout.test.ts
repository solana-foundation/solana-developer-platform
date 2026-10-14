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
import * as loggerModule from "@/runtime/logger";
import { RINGS_UNSIGNED_GRACE_MS } from "@/services/jobs/poll-rings-indexing";
import { STUCK_PROCESSING_AFTER_MS } from "@/services/jobs/track-pending-transfers";
import {
  boundSigningTime,
  CUSTODY_SIGNING_TIMEOUT_MS,
  custodySigningTimeoutMs,
  MAX_CUSTODY_SIGNING_TIMEOUT_MS,
  warnIfCustodySigningBudgetCapped,
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

    const longerBudget = custodySigningTimeoutMs({
      UTILA_POLL_INTERVAL_MS: "1000",
      UTILA_MAX_POLL_ATTEMPTS: "70",
    });
    expect(longerBudget).toBe(85_000);
  });

  it("never drops below the base bound for a short budget", () => {
    expect(
      custodySigningTimeoutMs({ UTILA_POLL_INTERVAL_MS: "100", UTILA_MAX_POLL_ATTEMPTS: "5" })
    ).toBeGreaterThanOrEqual(CUSTODY_SIGNING_TIMEOUT_MS);
  });

  // A signer still running past a recovery window is failed under it, and its
  // late signature can no longer be recorded.
  it("caps a long configured budget below every recovery window that fails unsigned rows", () => {
    const capped = custodySigningTimeoutMs({
      UTILA_POLL_INTERVAL_MS: "6000",
      UTILA_MAX_POLL_ATTEMPTS: "50",
    });
    expect(capped).toBe(MAX_CUSTODY_SIGNING_TIMEOUT_MS);
    expect(MAX_CUSTODY_SIGNING_TIMEOUT_MS).toBeLessThan(RINGS_UNSIGNED_GRACE_MS);
    expect(MAX_CUSTODY_SIGNING_TIMEOUT_MS).toBeLessThan(STUCK_PROCESSING_AFTER_MS);
  });
});

describe("warnIfCustodySigningBudgetCapped", () => {
  it("warns only when the configured budget exceeds the cap", () => {
    const warn = vi.fn();
    const logger = vi.spyOn(loggerModule, "getLogger").mockReturnValue({
      ...loggerModule.getLogger(),
      warn,
    });
    try {
      warnIfCustodySigningBudgetCapped({});
      expect(warn).not.toHaveBeenCalled();
      warnIfCustodySigningBudgetCapped({
        UTILA_POLL_INTERVAL_MS: "6000",
        UTILA_MAX_POLL_ATTEMPTS: "50",
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: "sdp_custody_signing_budget_capped",
          requested_ms: 315_000,
          cap_ms: MAX_CUSTODY_SIGNING_TIMEOUT_MS,
        }),
        expect.any(String)
      );
    } finally {
      logger.mockRestore();
    }
  });
});
