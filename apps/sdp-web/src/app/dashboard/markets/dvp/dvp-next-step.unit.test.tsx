/**
 * Whose move is it.
 *
 * The interesting cases are the ones the status word alone gets wrong.
 * "Partially funded" is the same string whether you owe a leg or are waiting on
 * someone else, and telling an operator to fund a leg they already funded is
 * how you get an over-funded escrow. The parties' standing comes from the
 * derived `kind` and each leg's `wallet`, never re-derived client-side.
 *
 * Asserts on the rendered English rather than translation keys, so a key that
 * exists in the component but not in the catalogue fails here.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OTHER_ADDRESS, ownParty, testLeg, testTrade } from "./dvp.fixtures";
import { DvpNextStep } from "./dvp-next-step";
import type { DvpTradeStatus } from "./dvp-trade";

function trade({
  status,
  kind = "principal",
  custodied = "none",
  fundedA = "unset",
  fundedB = "unset",
  yourSide,
}: {
  status: DvpTradeStatus;
  kind?: "principal" | "agent" | "bilateral";
  /** Which sides the caller holds custody of, per the wire. */
  custodied?: "a" | "b" | "both" | "none";
  fundedA?: boolean | null | "unset";
  fundedB?: boolean | null | "unset";
  yourSide?: "a" | "b";
}): ReturnType<typeof testTrade> {
  const fundingFor = (value: boolean | null | "unset") =>
    value === "unset"
      ? null
      : value === null
        ? null
        : { observedAmount: value ? "1000" : "0", funded: value, surplus: null, frozen: false };
  return testTrade({
    status,
    kind,
    yourSide,
    legs: {
      a: testLeg({
        party:
          custodied === "a" || custodied === "both"
            ? ownParty()
            : { address: OTHER_ADDRESS, counterparty: null, wallet: null },
        funding: fundingFor(fundedA),
      }),
      b: testLeg({
        party:
          custodied === "b" || custodied === "both"
            ? ownParty()
            : { address: OTHER_ADDRESS, counterparty: null, wallet: null },
        funding: fundingFor(fundedB),
      }),
    },
  });
}

function renderStep(value: ReturnType<typeof testTrade>): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpNextStep trade={value} />
    </I18nProvider>
  );
}

describe("DvpNextStep — principal", () => {
  it("tells you to fund your leg when neither side has", () => {
    const html = renderStep(trade({ status: "created", custodied: "a" }));

    expect(html).toContain("Your leg is not funded yet");
    expect(html).toContain("The counterparty funds theirs");
  });

  // Same status word, opposite instruction. Getting this backwards would tell
  // someone to fund a leg they already funded, which over-funds the escrow.
  it("waits on the counterparty once your leg is funded", () => {
    const html = renderStep(trade({ status: "partially_funded", custodied: "a", fundedA: true }));

    expect(html).toContain("Waiting on the counterparty");
    expect(html).not.toContain("Your leg is not funded yet");
  });

  it("says the counterparty has already paid when only your leg is missing", () => {
    const html = renderStep(trade({ status: "partially_funded", custodied: "a", fundedB: true }));

    expect(html).toContain("The counterparty has already funded");
  });

  // Which leg is "ours" flips with the custodied side. Reading the wrong one
  // would invert the advice for every trade where the caller holds the cash.
  it("reads the right leg as yours when the caller holds side B", () => {
    const html = renderStep(trade({ status: "partially_funded", custodied: "b", fundedB: true }));

    expect(html).toContain("Waiting on the counterparty");
  });

  it("offers settlement once both legs are funded", () => {
    const html = renderStep(
      trade({ status: "funded", custodied: "a", fundedA: true, fundedB: true })
    );

    expect(html).toContain("Ready to settle");
  });
});

describe("DvpNextStep — bilateral", () => {
  it("says both legs are yours and to fund them", () => {
    const html = renderStep(trade({ status: "created", kind: "bilateral", custodied: "both" }));

    expect(html).toContain("Both legs are yours");
    expect(html).toContain("Fund each one below");
  });

  it("still points at the outstanding leg when one of yours is funded", () => {
    const html = renderStep(
      trade({
        status: "partially_funded",
        kind: "bilateral",
        custodied: "both",
        fundedA: true,
      })
    );

    expect(html).toContain("Both legs are yours");
  });

  it("offers settlement once both of your legs are funded", () => {
    const html = renderStep(
      trade({
        status: "funded",
        kind: "bilateral",
        custodied: "both",
        fundedA: true,
        fundedB: true,
      })
    );

    expect(html).toContain("Ready to settle");
  });
});

describe("DvpNextStep — agent", () => {
  it("waits on both parties, saying you hold neither leg", () => {
    const html = renderStep(trade({ status: "created", kind: "agent" }));

    expect(html).toContain("Waiting on both parties");
    expect(html).toContain("You hold neither leg");
  });
});

describe("DvpNextStep — party view", () => {
  it("does not tell a party of another org's trade they hold neither leg", () => {
    const html = renderStep(
      trade({ status: "created", kind: "agent", custodied: "b", yourSide: "b" })
    );

    expect(html).toContain("Your leg is not funded yet");
    expect(html).not.toContain("You hold neither leg");
  });
});

describe("DvpNextStep — terminal states", () => {
  it("explains a trade that is past its expiry", () => {
    expect(renderStep(trade({ status: "expired", custodied: "a" }))).toContain("Past its expiry");
  });

  it("says nothing was created when the create failed", () => {
    expect(renderStep(trade({ status: "create_failed", custodied: "a" }))).toContain(
      "never created"
    );
  });

  it("says the create has not landed yet", () => {
    expect(renderStep(trade({ status: "creating", custodied: "a" }))).toContain(
      "Waiting for the create to land"
    );
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
