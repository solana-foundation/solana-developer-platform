/**
 * Whose move is it.
 *
 * The interesting cases are the ones the status word alone gets wrong.
 * "Partially funded" is the same string whether you owe a leg or are waiting on
 * someone else, and telling an operator to fund a leg they already funded is
 * how you get an over-funded escrow.
 *
 * Asserts on the rendered English rather than translation keys, so a key that
 * exists in the component but not in the catalogue fails here.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DvpNextStep } from "./dvp-next-step";
import type { DvpTrade, DvpTradeLeg, DvpTradeStatus } from "./dvp-trade";

function leg(funded: boolean | null): DvpTradeLeg {
  return {
    party: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    amount: "1000",
    escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    settlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    funding:
      funded === null
        ? null
        : { observedAmount: funded ? "1000" : "0", funded, surplus: null, frozen: false },
  };
}

function trade({
  status,
  sdpSide = "a",
  ours = false,
  theirs = false,
}: {
  status: DvpTradeStatus;
  sdpSide?: "a" | "b";
  ours?: boolean | null;
  theirs?: boolean | null;
}): DvpTrade {
  const ourLeg = leg(ours);
  const theirLeg = leg(theirs);
  return {
    id: "dvp_1",
    status,
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: sdpSide === "a" ? { a: ourLeg, b: theirLeg } : { a: theirLeg, b: ourLeg },
    sdpSide,
    nonce: "42",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    refString: null,
    createSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function renderStep(value: DvpTrade): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpNextStep trade={value} />
    </I18nProvider>
  );
}

describe("DvpNextStep", () => {
  it("tells you to fund your leg when neither side has", () => {
    const html = renderStep(trade({ status: "created" }));

    expect(html).toContain("Your leg is not funded yet");
    expect(html).toContain("The counterparty funds theirs");
  });

  // Same status word, opposite instruction. Getting this backwards would tell
  // someone to fund a leg they already funded, which over-funds the escrow.
  it("waits on the counterparty once your leg is funded", () => {
    const html = renderStep(trade({ status: "partially_funded", ours: true }));

    expect(html).toContain("Waiting on the counterparty");
    expect(html).not.toContain("Your leg is not funded yet");
  });

  it("says the counterparty has already paid when only your leg is missing", () => {
    const html = renderStep(trade({ status: "partially_funded", theirs: true }));

    expect(html).toContain("The counterparty has already funded");
  });

  // Which leg is "ours" flips with the side. Reading the wrong one would invert
  // the advice for every trade where SDP holds the cash.
  it("reads the right leg as yours when you hold side B", () => {
    const html = renderStep(trade({ status: "partially_funded", sdpSide: "b", ours: true }));

    expect(html).toContain("Waiting on the counterparty");
  });

  it("offers settlement once both legs are funded", () => {
    const html = renderStep(trade({ status: "funded", ours: true, theirs: true }));

    expect(html).toContain("Ready to settle");
  });

  it("explains a trade that is past its expiry", () => {
    expect(renderStep(trade({ status: "expired" }))).toContain("Past its expiry");
  });

  it("says nothing was created when the create failed", () => {
    expect(renderStep(trade({ status: "create_failed" }))).toContain("never created");
  });

  it("says the create has not landed yet", () => {
    expect(renderStep(trade({ status: "creating" }))).toContain("Waiting for the create to land");
  });

  // A closed trade has no next step, and inventing one would be worse than the
  // status badge saying "Settled" on its own.
  it.each(["settled", "cancelled", "rejected", "closed_unknown"] as const)(
    "renders nothing for a %s trade",
    (status) => {
      expect(renderStep(trade({ status }))).toBe("");
    }
  );
});
