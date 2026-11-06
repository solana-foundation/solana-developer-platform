import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { PAYMENT_COMMAND_ACTION_DESTINATIONS } from "./payments-command-center.constants";
import {
  activityTransferTypes,
  depositLineKey,
  payLineKey,
  resolveCommandCenterCounterparty,
} from "./payments-command-center.utils";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummarySkeleton,
} from "./payments-command-center-skeletons";

describe("payments command center", () => {
  it("routes each move-money action to its canonical flow", () => {
    expect(PAYMENT_COMMAND_ACTION_DESTINATIONS).toEqual({
      pay: "/dashboard/payments/pay",
      deposit: "/dashboard/payments/deposit",
      request: "/dashboard/payments/requests",
      schedule: "/dashboard/payments/recurring/create",
    });
  });

  it("asks the activity list for ramp types only where Ramps runs", () => {
    // The API 403s an explicitly requested ramp type outside Ramps' channel, which emptied
    // the stable overview's activity.
    expect(activityTransferTypes(false)).toEqual(["transfer"]);
    expect(activityTransferTypes(true)).toEqual(["transfer", "onramp", "offramp"]);
  });

  it("names fiat and screening on the Pay and Deposit lines only where their modules run", () => {
    // Stable runs neither Ramps nor Compliance, and its tiles offered both.
    const lines = getMessages("en").DashboardPayments.newDesign.commandCenter;
    expect(payLineKey({ ramps: false, compliance: false })).toBe(
      "DashboardPayments.newDesign.commandCenter.payDescriptionOnchain"
    );
    expect(payLineKey({ ramps: true, compliance: false })).toBe(
      "DashboardPayments.newDesign.commandCenter.payDescriptionFiat"
    );
    expect(payLineKey({ ramps: false, compliance: true })).toBe(
      "DashboardPayments.newDesign.commandCenter.payDescriptionChecked"
    );
    expect(payLineKey({ ramps: true, compliance: true })).toBe(
      "DashboardPayments.newDesign.commandCenter.payDescription"
    );
    expect(depositLineKey(false)).toBe(
      "DashboardPayments.newDesign.commandCenter.depositDescriptionOnchain"
    );
    expect(depositLineKey(true)).toBe(
      "DashboardPayments.newDesign.commandCenter.depositDescription"
    );
    expect(lines.payDescriptionOnchain).not.toMatch(/fiat|check/i);
    expect(lines.depositDescriptionOnchain).not.toMatch(/fiat|ramp/i);
  });

  it("has independent loading geometry for every data-backed region", () => {
    const markup = renderToStaticMarkup(
      <>
        <PaymentsBalanceSkeleton />
        <PaymentsSummarySkeleton />
        <PaymentsActivitySkeleton />
      </>
    );

    for (const region of ["balance", "summary", "activity"]) {
      expect(markup).toContain(`data-payments-overview-skeleton="${region}"`);
    }
    expect(markup.match(/aria-busy="true"/g)).toHaveLength(3);
  });

  it("shows the sender rather than the project wallet for inbound and onramp activity", () => {
    expect(
      resolveCommandCenterCounterparty({
        id: "transfer-inbound",
        custodyWalletId: "cwlt_1",
        providerWalletId: "privy_1",
        status: "confirmed",
        signature: null,
        rampsMemo: {},
        direction: "inbound",
        source: "sender-wallet",
        destination: "project-wallet",
      })
    ).toBe("sender-wallet");
    expect(
      resolveCommandCenterCounterparty({
        id: "transfer-onramp",
        custodyWalletId: "cwlt_1",
        providerWalletId: "privy_1",
        status: "completed",
        signature: null,
        rampsMemo: {},
        type: "onramp",
        source: "ramp-provider",
        destination: "project-wallet",
      })
    ).toBe("ramp-provider");
  });
});
