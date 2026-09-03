import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpTrade, DvpTradeLeg } from "./dvp-trade";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

function render(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function leg(overrides: Partial<DvpTradeLeg> = {}): DvpTradeLeg {
  return {
    party: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amount: "1000",
    escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    settlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    funding: null,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return {
    id: "dvp_1",
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: { a: leg(), b: leg({ amount: "2000" }) },
    sdpSide: "a",
    nonce: "42",
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    refString: null,
    createSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("DvpTradesWorkspace", () => {
  it("explains what DvP is before showing an empty list", () => {
    const markup = render(<DvpTradesWorkspace error={null} trades={[]} />);

    expect(markup).toContain("No trades yet");
    expect(markup).toContain("both legs move together");
  });

  // A row that navigates, with actions living on the destination.
  it("makes every row a link to its trade", () => {
    const markup = render(<DvpTradesWorkspace error={null} trades={[trade()]} />);

    expect(markup).toContain('href="/dashboard/markets/dvp/dvp_1"');
  });

  // Showing a bare target for an unobserved leg is indistinguishable from one
  // that is exactly funded, which is the difference between "waiting" and
  // "ready".
  it("distinguishes an unobserved leg from an exactly funded one", () => {
    const unobserved = render(<DvpTradesWorkspace error={null} trades={[trade()]} />);
    expect(unobserved).toContain("— / 1000");

    const funded = render(
      <DvpTradesWorkspace
        error={null}
        trades={[
          trade({
            legs: {
              a: leg({
                funding: {
                  observedAmount: "1000",
                  funded: true,
                  surplus: null,
                  frozen: false,
                },
              }),
              b: leg({ amount: "2000" }),
            },
          }),
        ]}
      />
    );
    expect(funded).toContain("1000 / 1000");
  });

  // A warning that does not say WHICH trade sends an operator through every row
  // to find it, so it is marked on the row rather than announced in a banner.
  it("marks the row of a trade holding a surplus", () => {
    const markup = render(
      <DvpTradesWorkspace
        error={null}
        trades={[
          trade({
            legs: {
              a: leg({
                funding: {
                  observedAmount: "5000",
                  funded: true,
                  surplus: "4000",
                  frozen: false,
                },
              }),
              b: leg({ amount: "2000" }),
            },
          }),
        ]}
      />
    );

    expect(markup).toContain("Holds more than the trade needs");
  });

  it("leaves a healthy trade unmarked", () => {
    const markup = render(<DvpTradesWorkspace error={null} trades={[trade()]} />);

    expect(markup).not.toContain("Holds more than the trade needs");
  });

  it("surfaces a list error instead of rendering an empty table as success", () => {
    const markup = render(<DvpTradesWorkspace error="Upstream unavailable" trades={[]} />);

    expect(markup).toContain("Upstream unavailable");
    expect(markup).not.toContain("No trades yet");
  });
});
