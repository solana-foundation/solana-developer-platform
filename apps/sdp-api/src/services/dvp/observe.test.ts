import { describe, expect, it } from "vitest";
import { type DvpTradeExpectation, type DvpTradeObservation, deriveDvpTradeState } from "./observe";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function observation(overrides: Partial<DvpTradeObservation> = {}): DvpTradeObservation {
  return {
    tradeAccountExists: true,
    legA: { exists: true, amount: 0n, frozen: false },
    legB: { exists: true, amount: 0n, frozen: false },
    blockHeight: 1_000n,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpTradeExpectation> = {}): DvpTradeExpectation {
  return {
    status: "created",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: String(NOW_SECONDS + 3600),
    createLastValidBlockHeight: "1500",
    ...overrides,
  };
}

describe("deriveDvpTradeState", () => {
  describe("funding", () => {
    it("is created while both escrows are empty", () => {
      expect(deriveDvpTradeState(observation(), trade(), NOW_MS).status).toBe("created");
    });

    it("is partially_funded when one leg has paid", () => {
      const result = deriveDvpTradeState(
        observation({ legA: { exists: true, amount: 1000n, frozen: false } }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("partially_funded");
    });

    // A leg short by one base unit is not funded: Settle refuses the whole trade
    // with LegNotFunded, so calling it funded would promise a settlement that
    // cannot happen.
    it("is not funded when a leg is one unit short", () => {
      const result = deriveDvpTradeState(
        observation({
          legA: { exists: true, amount: 1000n, frozen: false },
          legB: { exists: true, amount: 1999n, frozen: false },
        }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("partially_funded");
    });

    it("is funded when both legs hold exactly their target", () => {
      const result = deriveDvpTradeState(
        observation({
          legA: { exists: true, amount: 1000n, frozen: false },
          legB: { exists: true, amount: 2000n, frozen: false },
        }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("funded");
      expect(result.overFunded).toBe(false);
    });

    // The threshold is `>=`, not equality (settle_dvp.rs:222-230). An over-funded
    // trade IS settleable — the surplus is refunded — so it must not be reported
    // as still waiting for money.
    it("is funded, and flagged over-funded, when a leg holds more than its target", () => {
      const result = deriveDvpTradeState(
        observation({
          legA: { exists: true, amount: 1_000_000_000n, frozen: false },
          legB: { exists: true, amount: 2000n, frozen: false },
        }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("funded");
      expect(result.overFunded).toBe(true);
    });

    // Surplus matters even before the trade is fully funded: the refund happens
    // at settle, so the risk is already present.
    it("flags a surplus on a leg that is over while the other is short", () => {
      const result = deriveDvpTradeState(
        observation({ legA: { exists: true, amount: 5000n, frozen: false } }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("partially_funded");
      expect(result.overFunded).toBe(true);
    });

    // Balance alone cannot tell "nobody has paid" from "payment is impossible".
    it("flags a frozen escrow, which is blocked rather than merely unpaid", () => {
      const result = deriveDvpTradeState(
        observation({ legA: { exists: true, amount: 0n, frozen: true } }),
        trade(),
        NOW_MS
      );
      expect(result.status).toBe("created");
      expect(result.frozenEscrow).toBe(true);
    });
  });

  describe("create resolution", () => {
    // Whether a create can still land is decided by its blockhash, not by how
    // long ago we sent it.
    it("stays creating while the create blockhash is still valid", () => {
      const result = deriveDvpTradeState(
        observation({ tradeAccountExists: false, blockHeight: 1_400n }),
        trade({ status: "creating" }),
        NOW_MS
      );
      expect(result.status).toBe("creating");
    });

    it("becomes create_failed once the cluster passes the last valid block height", () => {
      const result = deriveDvpTradeState(
        observation({ tradeAccountExists: false, blockHeight: 1_501n }),
        trade({ status: "creating" }),
        NOW_MS
      );
      expect(result.status).toBe("create_failed");
    });

    it("is still creating exactly AT the last valid block height", () => {
      const result = deriveDvpTradeState(
        observation({ tradeAccountExists: false, blockHeight: 1_500n }),
        trade({ status: "creating" }),
        NOW_MS
      );
      expect(result.status).toBe("creating");
    });

    // A row with no recorded height must never be guessed at: reporting
    // create_failed for a live trade says no escrow exists while its address is
    // on chain waiting to be funded.
    it("never fails a create it has no expiry height for", () => {
      const result = deriveDvpTradeState(
        observation({ tradeAccountExists: false, blockHeight: 999_999_999n }),
        trade({ status: "creating", createLastValidBlockHeight: null }),
        NOW_MS
      );
      expect(result.status).toBe("creating");
    });

    it("marks the trade created once its account is on chain", () => {
      const result = deriveDvpTradeState(observation(), trade({ status: "creating" }), NOW_MS);
      expect(result.status).toBe("created");
    });
  });

  describe("closure", () => {
    it("reports closed_unknown for a trade whose account has gone", () => {
      for (const status of ["created", "partially_funded", "funded", "expired"] as const) {
        const result = deriveDvpTradeState(
          observation({ tradeAccountExists: false }),
          trade({ status }),
          NOW_MS
        );
        expect(result.status).toBe("closed_unknown");
      }
    });

    // Settle, Cancel and Reject all close the account and none announce it.
    // Guessing "settled" would report a completed trade that may have been
    // rejected.
    it("does not guess which terminal path closed the account", () => {
      const result = deriveDvpTradeState(
        observation({ tradeAccountExists: false }),
        trade({ status: "funded" }),
        NOW_MS
      );
      expect(result.status).not.toBe("settled");
      expect(result.status).not.toBe("cancelled");
    });

    it("never walks a terminal trade backwards", () => {
      for (const status of ["settled", "cancelled", "rejected", "closed_unknown"] as const) {
        const result = deriveDvpTradeState(
          observation({ tradeAccountExists: false }),
          trade({ status }),
          NOW_MS
        );
        expect(result.status).toBe(status);
      }
    });
  });

  describe("expiry", () => {
    it("expires an underfunded trade past its expiry timestamp", () => {
      const result = deriveDvpTradeState(
        observation(),
        trade({ expiryTimestamp: String(NOW_SECONDS - 1) }),
        NOW_MS
      );
      expect(result.status).toBe("expired");
    });

    // A funded trade past expiry still holds both parties' money and needs
    // unwinding. Writing it off as expired would hide that.
    it("keeps a fully funded trade funded past expiry", () => {
      const result = deriveDvpTradeState(
        observation({
          legA: { exists: true, amount: 1000n, frozen: false },
          legB: { exists: true, amount: 2000n, frozen: false },
        }),
        trade({ expiryTimestamp: String(NOW_SECONDS - 1) }),
        NOW_MS
      );
      expect(result.status).toBe("funded");
    });
  });

  // u64 targets and balances both exceed 2^53. If either side of the comparison
  // went through a JS number, a leg short by millions could read as funded.
  it("compares amounts above 2^53 without losing precision", () => {
    const result = deriveDvpTradeState(
      observation({
        legA: { exists: true, amount: 18_446_744_073_709_551_614n, frozen: false },
        legB: { exists: true, amount: 2000n, frozen: false },
      }),
      trade({ amountA: "18446744073709551615" }),
      NOW_MS
    );
    // One unit short of a u64 max target. A float comparison would call this equal.
    expect(result.status).toBe("partially_funded");
    expect(result.overFunded).toBe(false);
  });
});
