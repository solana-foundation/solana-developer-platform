import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAYMENT_COMMAND_ACTION_DESTINATIONS } from "./payments-command-center.constants";
import {
  PaymentsActivitySkeleton,
  PaymentsBalanceSkeleton,
  PaymentsSummaryCardSkeleton,
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
        <PaymentsSummaryCardSkeleton name="upcoming" />
        <PaymentsSummaryCardSkeleton name="network" />
      </>
    );

    for (const region of ["balance", "activity", "upcoming", "network"]) {
      expect(markup).toContain(`data-payments-overview-skeleton="${region}"`);
    }
    expect(markup.match(/aria-busy="true"/g)).toHaveLength(4);
  });
});
