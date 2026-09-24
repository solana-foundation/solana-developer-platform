import { describe, expect, it } from "vitest";
import {
  activityKind,
  formatElapsedShort,
  formatSignedAmount,
  PAYMENT_STATUS_TONE,
  summarizeBatch,
} from "./payments-presentation";

describe("PAYMENT_STATUS_TONE", () => {
  it("separates rails in motion from states waiting on someone", () => {
    expect(PAYMENT_STATUS_TONE.processing).toBe("progress");
    expect(PAYMENT_STATUS_TONE.settling).toBe("progress");
    expect(PAYMENT_STATUS_TONE.pending).toBe("attention");
    expect(PAYMENT_STATUS_TONE.awaiting_payment).toBe("attention");
    expect(PAYMENT_STATUS_TONE.finalized).toBe("positive");
    expect(PAYMENT_STATUS_TONE.failed).toBe("critical");
    expect(PAYMENT_STATUS_TONE.expired).toBe("neutral");
  });
});

describe("activityKind", () => {
  it("prefers the ledger kind", () => {
    expect(activityKind({ kind: "offramp", type: "offramp" })).toBe("pay");
    expect(activityKind({ kind: "request_deposit", type: "transfer" })).toBe("deposit");
    expect(activityKind({ kind: "batch_pay", type: "transfer" })).toBe("batch");
  });

  it("falls back to type and direction", () => {
    expect(activityKind({ type: "onramp" })).toBe("deposit");
    expect(activityKind({ type: "transfer", direction: "inbound" })).toBe("deposit");
    expect(activityKind({ type: "transfer", direction: "outbound" })).toBe("transfer");
    expect(activityKind({ type: "transfer_batch" })).toBe("batch");
  });
});

describe("formatSignedAmount", () => {
  it("signs by direction with a typographic minus and two fraction digits", () => {
    expect(formatSignedAmount("2400", "outbound", "USDC", "en-US")).toBe("−2,400.00 USDC");
    expect(formatSignedAmount("-18.4", "inbound", "SOL", "en-US")).toBe("+18.40 SOL");
    expect(formatSignedAmount("0.000125", undefined, undefined, "en-US")).toBe("0.000125");
  });

  it("returns null without an amount", () => {
    expect(formatSignedAmount(undefined, "outbound", "USDC")).toBeNull();
  });
});

describe("formatElapsedShort", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");

  it("uses one narrow unit", () => {
    expect(formatElapsedShort("2026-09-24T11:58:00Z", "en-US", now)).toBe("2m");
    expect(formatElapsedShort("2026-09-24T09:00:00Z", "en-US", now)).toBe("3h");
    expect(formatElapsedShort("2026-09-19T12:00:00Z", "en-US", now)).toBe("5d");
    expect(formatElapsedShort("2026-09-24T11:59:50Z", "en-US", now)).toBe("1m");
  });

  it("switches to a date after a week or for future times", () => {
    expect(formatElapsedShort("2026-09-10T12:00:00Z", "en-US", now)).toBe("Sep 10");
    expect(formatElapsedShort("2026-09-25T12:00:00Z", "en-US", now)).toBe("Sep 25");
  });

  it("returns null for a missing or invalid timestamp", () => {
    expect(formatElapsedShort(undefined)).toBeNull();
    expect(formatElapsedShort("not a date")).toBeNull();
  });
});

describe("summarizeBatch", () => {
  const recipient = (status: "pending" | "confirmed" | "failed") => ({ status });

  it("counts recipients when it has them", () => {
    expect(
      summarizeBatch({ status: "partially_failed", recipientCount: 8 }, [
        recipient("failed"),
        ...Array.from({ length: 7 }, () => recipient("confirmed")),
      ])
    ).toEqual({
      key: "DashboardPayments.batchSummary.someFailed",
      values: { failed: 1, count: 8 },
      tone: "attention",
    });
    expect(
      summarizeBatch({ status: "processing", recipientCount: 3 }, [
        recipient("confirmed"),
        recipient("pending"),
        recipient("pending"),
      ])
    ).toMatchObject({ key: "DashboardPayments.batchSummary.confirmedOf", tone: "progress" });
    expect(
      summarizeBatch({ status: "confirmed", recipientCount: 2 }, [
        recipient("confirmed"),
        recipient("confirmed"),
      ])
    ).toMatchObject({ key: "DashboardPayments.batchSummary.allSettled", tone: "positive" });
  });

  it("reads the batch status without recipients", () => {
    expect(summarizeBatch({ status: "partially_failed", recipientCount: 8 })).toMatchObject({
      key: "DashboardPayments.batchSummary.partiallyFailed",
      values: { count: 8 },
    });
    expect(summarizeBatch({ status: "archived", recipientCount: 4 }).tone).toBe("neutral");
  });
});
