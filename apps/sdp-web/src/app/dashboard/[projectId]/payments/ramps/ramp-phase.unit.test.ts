import type { PaymentTransferSummary } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { rampPhase, rampPhaseCopy, rampTransferPollInterval } from "./ramp-phase";

const messages = getMessages("en");
const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

function transfer(overrides: Partial<PaymentTransferSummary>): PaymentTransferSummary {
  return {
    id: "xfr_phase",
    custodyWalletId: "cwlt_phase",
    providerWalletId: "wallet_phase",
    status: "pending",
    signature: null,
    rampsMemo: {},
    type: "onramp",
    provider: "moonpay",
    deliveryMode: "hosted",
    ...overrides,
  };
}

describe("rampPhase", () => {
  it("waits on the customer, not a spinner, while they are in the provider window", () => {
    expect(rampPhase(transfer({ status: "pending" }))).toEqual({
      kind: "checkout",
      tone: "action",
    });
    expect(rampPhase(transfer({ type: "offramp", status: "pending" })).kind).toBe("checkout");
  });

  it("names no ramp phase for the wallet-send statuses no ramp row holds", () => {
    expect(rampPhase(transfer({ status: "confirmed" })).kind).toBe("unknown");
    expect(rampPhase(transfer({ status: "finalized" })).kind).toBe("unknown");
  });

  it("reads an off-ramp with a deposit instruction as ready to send", () => {
    const ready = transfer({
      type: "offramp",
      status: "awaiting_payment",
      cryptoDeposit: { destinationAddress: "deposit", amount: "25" },
    });
    expect(rampPhase(ready)).toEqual({ kind: "ready_to_send", tone: "action" });
    expect(rampPhase({ ...ready, cryptoDeposit: undefined }).kind).toBe("awaiting_instruction");
  });

  it("keeps an on-ramp confirming until SDP verifies the reported delivery", () => {
    expect(rampPhase(transfer({ status: "settling" })).kind).toBe("provider_delivering");
    expect(rampPhase(transfer({ status: "settling", signature: "sig" })).kind).toBe(
      "confirming_delivery"
    );
    expect(rampPhase(transfer({ status: "completed", signature: "sig" })).kind).toBe("completed");
  });

  it("reads a reported payout on a settling off-ramp", () => {
    const settling = transfer({ type: "offramp", status: "settling" });
    expect(rampPhase(settling).kind).toBe("paying_out");
    expect(rampPhase({ ...settling, fiatPayout: { amount: "20.82", currency: "USD" } }).kind).toBe(
      "payout_reported"
    );
  });

  it("puts a held delivery before its status", () => {
    const held = transfer({
      status: "settling",
      signature: "sig",
      deliveryMismatch: { reason: "amount_mismatch", checkedAt: "2026-10-20T01:14:00.000Z" },
    });
    expect(rampPhase(held)).toEqual({ kind: "needs_review", tone: "attention" });
  });
});

describe("rampTransferPollInterval", () => {
  it("polls quickly while someone is about to act and stops once the transfer is final", () => {
    expect(rampTransferPollInterval(undefined)).toBe(3_000);
    expect(rampTransferPollInterval(transfer({ status: "pending" }))).toBe(3_000);
    expect(rampTransferPollInterval(transfer({ status: "completed" }))).toBe(0);
  });

  it("slows through a bank payout and a hold only a new report clears", () => {
    expect(rampTransferPollInterval(transfer({ type: "offramp", status: "settling" }))).toBe(
      15_000
    );
    expect(
      rampTransferPollInterval(
        transfer({
          status: "settling",
          deliveryMismatch: { reason: "not_delivered", checkedAt: "2026-10-20T01:14:00.000Z" },
        })
      )
    ).toBe(30_000);
  });
});

describe("rampPhaseCopy", () => {
  it("says what the provider reported against what the wallet received", () => {
    const copy = rampPhaseCopy(
      t,
      transfer({
        status: "settling",
        signature: "sig",
        token: requiredWellKnownMint("USDC", "devnet"),
        deliveryMismatch: {
          reason: "amount_mismatch",
          checkedAt: "2026-10-20T01:14:00.000Z",
          reportedAmount: "20.000000",
          observedAmount: "0.5",
        },
      }),
      { tokenLabel: "USDC", locale: "en" }
    );
    expect(copy.title).toBe("Delivery needs review");
    expect(copy.description).toContain("MoonPay reports 20.00 USDC delivered");
    expect(copy.description).toContain("the wallet received 0.50 USDC");
  });

  it("keeps every digit of amounts that differ past six places", () => {
    const copy = rampPhaseCopy(
      t,
      transfer({
        status: "settling",
        signature: "sig",
        token: SOL_MINT,
        deliveryMismatch: {
          reason: "amount_mismatch",
          checkedAt: "2026-10-20T01:14:00.000Z",
          reportedAmount: "1.000000002",
          observedAmount: "1.000000001",
        },
      }),
      { tokenLabel: "SOL", locale: "en" }
    );
    expect(copy.description).toContain("MoonPay reports 1.000000002 SOL delivered");
    expect(copy.description).toContain("the wallet received 1.000000001 SOL");
  });

  it("says what the provider paid out once a sale completes", () => {
    const copy = rampPhaseCopy(
      t,
      transfer({
        type: "offramp",
        status: "completed",
        fiatPayout: { amount: "20.82", currency: "USD" },
      }),
      { tokenLabel: "USDC", locale: "en" }
    );
    expect(copy.title).toBe("Payout sent");
    expect(copy.description).toBe("MoonPay paid out 20.82 USD, and the deposit finalized onchain.");
  });

  it("names the provider's reason in SDP's words when a sale fails", () => {
    const copy = rampPhaseCopy(
      t,
      transfer({ type: "offramp", status: "failed", error: "Deposit timeout" }),
      { tokenLabel: "USDC", locale: "en" }
    );
    expect(copy).toMatchObject({
      tone: "error",
      title: "Payout failed",
      description: "MoonPay reported that this sale failed: Deposit timeout",
    });
  });

  it("asks for the deposit amount on an off-ramp ready to send", () => {
    const copy = rampPhaseCopy(
      t,
      transfer({
        type: "offramp",
        status: "awaiting_payment",
        cryptoDeposit: { destinationAddress: "deposit", amount: "25" },
      }),
      { tokenLabel: "USDC", locale: "en" }
    );
    expect(copy.description).toBe("MoonPay is ready for 25.00 USDC. Send it to start the payout.");
  });
});
