import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAYMENT_COMMAND_ACTION_DESTINATIONS } from "./payments-command-center.constants";
import { resolveCommandCenterCounterparty } from "./payments-command-center.utils";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsNetworkSkeleton,
  PaymentsUpcomingSkeleton,
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

  it("has independent loading geometry for every data-backed region", () => {
    const markup = renderToStaticMarkup(
      <>
        <PaymentsBalanceSkeleton />
        <PaymentsActivitySkeleton />
        <PaymentsUpcomingSkeleton />
        <PaymentsNetworkSkeleton />
      </>
    );

    for (const region of ["balance", "activity", "upcoming", "network"]) {
      expect(markup).toContain(`data-payments-overview-skeleton="${region}"`);
    }
    expect(markup.match(/aria-busy="true"/g)).toHaveLength(4);
  });

  it("shows the sender rather than the project wallet for inbound and onramp activity", () => {
    expect(
      resolveCommandCenterCounterparty({
        id: "transfer-inbound",
        status: "confirmed",
        signature: null,
        direction: "inbound",
        source: "sender-wallet",
        destination: "project-wallet",
      })
    ).toBe("sender-wallet");
    expect(
      resolveCommandCenterCounterparty({
        id: "transfer-onramp",
        status: "completed",
        signature: null,
        type: "onramp",
        source: "ramp-provider",
        destination: "project-wallet",
      })
    ).toBe("ramp-provider");
  });
});
