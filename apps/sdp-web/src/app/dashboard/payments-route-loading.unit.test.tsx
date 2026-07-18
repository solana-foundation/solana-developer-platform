import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PublicPayLoading from "../pay/[token]/loading";
import DashboardLoading from "./loading";
import CounterpartyDetailLoading from "./payments/counterparty/[counterpartyId]/loading";
import CounterpartyCreateLoading from "./payments/counterparty/create/loading";
import CounterpartyLoading from "./payments/counterparty/loading";
import DepositLoading from "./payments/deposit/loading";
import PaymentsLoading from "./payments/loading";
import PayLoading from "./payments/pay/loading";
import RecurringPaymentDetailLoading from "./payments/recurring/[recurringPaymentId]/loading";
import RecurringPaymentCreateLoading from "./payments/recurring/create/loading";
import RecurringPaymentsLoading from "./payments/recurring/loading";
import PaymentRequestsLoading from "./payments/requests/loading";

const EXPECTED_ROUTE_LAYOUTS = [
  "home",
  "payments-overview",
  "payments-pay",
  "payments-deposit",
  "payment-requests",
  "counterparty-directory",
  "counterparty-create",
  "counterparty-detail",
  "recurring-payments",
  "recurring-payment-create",
  "recurring-payment-detail",
  "public-pay-checkout",
];

function renderScopedLoadingStates(): string {
  return renderToStaticMarkup(
    <>
      <DashboardLoading />
      <PaymentsLoading />
      <PayLoading />
      <DepositLoading />
      <PaymentRequestsLoading />
      <CounterpartyLoading />
      <CounterpartyCreateLoading />
      <CounterpartyDetailLoading />
      <RecurringPaymentsLoading />
      <RecurringPaymentCreateLoading />
      <RecurringPaymentDetailLoading />
      <PublicPayLoading />
    </>
  );
}

describe("home and payments route loading states", () => {
  it("gives every scoped route a geometry-specific loading boundary", () => {
    const markup = renderScopedLoadingStates();

    for (const layout of EXPECTED_ROUTE_LAYOUTS) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
    }
  });

  it("preserves the responsive table, wizard, and detail geometry", () => {
    const markup = renderScopedLoadingStates();

    expect(markup.match(/data-loading-table/g)).toHaveLength(5);
    expect(markup.match(/data-loading-wizard/g)).toHaveLength(4);
    expect(markup.match(/data-loading-detail-rows/g)).toHaveLength(2);
    expect(markup).toContain("lg:grid-cols-2");
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("size-[208px]");
  });

  it("keeps the recurring list loader contained at a 390px viewport", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentsLoading />);

    expect(markup).toContain("flex min-w-0 flex-col gap-4 sm:grid");
    expect(markup).toContain("h-full min-h-0 min-w-0 flex-col");
    expect(markup).toContain("min-w-0 max-w-full");
  });
});
