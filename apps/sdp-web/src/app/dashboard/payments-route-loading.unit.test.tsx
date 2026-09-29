import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublicPayLoading from "../pay/[token]/loading";
import DashboardLoading from "./(home)/loading";
import CounterpartyDetailLoading from "./payments/counterparty/[counterpartyId]/loading";
import CounterpartyCreateLoading from "./payments/counterparty/create/loading";
import CounterpartyLoading from "./payments/counterparty/loading";
import DepositLoading from "./payments/deposit/loading";
import PaymentsLoading from "./payments/loading";
import PayLoading from "./payments/pay/loading";
import {
  CounterpartyDirectorySkeleton,
  PaymentRequestsPageSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
} from "./payments/payments-route-skeletons";
import RecurringPaymentDetailLoading from "./payments/recurring/[recurringPaymentId]/loading";
import RecurringPaymentCreateLoading from "./payments/recurring/create/loading";
import RecurringPaymentsLoading from "./payments/recurring/loading";
import PaymentRequestsLoading from "./payments/requests/loading";
import PaymentRequestCreateLoading from "./payments/requests/new/loading";
import TransactionsLoading from "./payments/transactions/loading";

const navigationMock = vi.hoisted(() => ({ tab: null as null | "playground" }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: () => undefined }),
    useSearchParams: () =>
      new URLSearchParams(navigationMock.tab ? { tab: navigationMock.tab } : undefined),
  };
});

const EXPECTED_ROUTE_LAYOUTS = [
  "home",
  "payments-overview",
  "payments-transactions",
  "payments-pay",
  "payments-deposit",
  "payment-requests",
  "payment-request-create",
  "counterparty-directory",
  "counterparty-create",
  "counterparty-detail",
  "recurring-payments",
  "recurring-payment-create",
  "recurring-payment-detail",
  "public-pay-checkout",
];

function renderAuthenticatedLoadingStates(): string {
  return renderToStaticMarkup(
    <>
      <DashboardLoading />
      <PaymentsLoading />
      <PayLoading />
      <DepositLoading />
      <PaymentRequestsLoading />
      <PaymentRequestCreateLoading />
      <TransactionsLoading />
      <CounterpartyLoading />
      <CounterpartyCreateLoading />
      <CounterpartyDetailLoading />
      <RecurringPaymentsLoading />
      <RecurringPaymentCreateLoading />
      <RecurringPaymentDetailLoading />
    </>
  );
}

function renderScopedLoadingStates(): string {
  return `${renderAuthenticatedLoadingStates()}${renderToStaticMarkup(<PublicPayLoading />)}`;
}

describe("home and payments route loading states", () => {
  afterEach(() => {
    navigationMock.tab = null;
  });

  it("gives every scoped route a geometry-specific loading boundary", () => {
    const markup = renderScopedLoadingStates();

    for (const layout of EXPECTED_ROUTE_LAYOUTS) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
    }
  });

  it("preserves the responsive table, wizard, and detail geometry", () => {
    const markup = renderScopedLoadingStates();

    expect(markup.match(/data-loading-table="true"/g)).toHaveLength(5);
    expect(markup.match(/data-loading-wizard/g)).toHaveLength(4);
    expect(markup.match(/data-loading-detail-rows/g)).toHaveLength(4);
    expect(markup).toContain("lg:grid-cols-2");
    expect(markup).toContain("size-[208px]");
  });

  it("draws the refresh lists as a toolbar over a scrolling table in the title's column", () => {
    const listCases = [
      {
        layout: "payments-transactions",
        markup: renderToStaticMarkup(<TransactionsLoading />),
        columns: ["status", "type", "amount", "contact", "wallet", "created"],
      },
      {
        layout: "payment-requests",
        markup: renderToStaticMarkup(<PaymentRequestsPageSkeleton />),
        columns: ["status", "amount", "from", "to", "created", "actions"],
      },
      {
        layout: "counterparty-directory",
        markup: renderToStaticMarkup(<CounterpartyDirectorySkeleton />),
        columns: ["name", "type", "external-id", "address", "created", "actions"],
      },
      {
        layout: "recurring-payments",
        markup: renderToStaticMarkup(<RecurringPaymentsPageSkeleton />),
        columns: ["status", "schedule", "repeats", "next-run"],
      },
    ];

    for (const { layout, markup, columns } of listCases) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
      expect(markup).toContain(`data-loading-table-variant="${layout}"`);
      expect(markup.match(/data-loading-list-toolbar=/g)).toHaveLength(1);
      expect(markup.match(/data-loading-column="([^"]+)"/g)).toEqual(
        columns.map((column) => `data-loading-column="${column}"`)
      );
      expect(markup.match(/data-loading-table-row=/g)).toHaveLength(5);
      // The settled lists scroll sideways on narrow screens rather than swapping to cards.
      expect(markup).toContain("overflow-x-auto");
      expect(markup).toContain("min-w-[760px]");
      expect(markup).not.toContain("data-loading-mobile-rows");
    }
  });

  it("loads Contacts and Requests as lists, whatever tab the URL carries", () => {
    // Both pages redirect ?tab=playground to the Payments playground, so a leftover tab never
    // swaps in a playground skeleton.
    navigationMock.tab = "playground";
    expect(renderToStaticMarkup(<CounterpartyLoading />)).toContain(
      'data-loading-layout="counterparty-directory"'
    );
    expect(renderToStaticMarkup(<PaymentRequestsLoading />)).toContain(
      'data-loading-layout="payment-requests"'
    );
    navigationMock.tab = null;
  });

  it("opens the schedule wizard on its payment step", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentCreateSkeleton />);

    // The step's question, then contact, source wallet, and amount beside token.
    expect(markup).toContain('data-loading-layout="recurring-payment-create"');
    expect(markup.match(/data-loading-stepper=/g)).toHaveLength(1);
    expect(markup.match(/data-loading-field=/g)).toHaveLength(4);
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("shrink-0 border-t");
    expect(markup).not.toContain("data-loading-counterparty-picker");
  });

  it("opens Pay on its details step and Deposit on its address tab", () => {
    const pay = renderToStaticMarkup(<PaymentsPayPageSkeleton />);
    expect(pay).toContain('data-loading-layout="payments-pay"');
    expect(pay.match(/data-loading-stepper=/g)).toHaveLength(1);
    expect(pay.match(/data-loading-field=/g)).toHaveLength(5);
    expect(pay).toContain("max-w-flow");
    // The step scrolls in its own column; the footer band stays at the bottom of the page.
    expect(pay).toContain("overflow-y-auto");
    expect(pay).toContain("shrink-0 border-t");
    expect(pay).not.toContain("data-loading-counterparty-picker");

    const deposit = renderToStaticMarkup(<PaymentsDepositPageSkeleton />);
    expect(deposit).toContain('data-loading-layout="payments-deposit"');
    expect(deposit.match(/data-loading-deposit-address=/g)).toHaveLength(1);
    expect(deposit).toContain("size-28");
    expect(deposit).not.toContain("data-loading-wizard");
  });

  it("keeps recurring detail scrollable while its data is pending", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentDetailSkeleton />);

    expect(markup).toContain('data-loading-layout="recurring-payment-detail"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).not.toContain("overflow-hidden");
  });

  it("matches the Home activity Card's settled responsive table geometry", () => {
    const markup = renderToStaticMarkup(<DashboardLoading />);

    expect(markup.match(/data-loading-home-activity=/g)).toHaveLength(1);
    expect(markup.match(/data-loading-home-activity-header=/g)).toHaveLength(1);
    expect(markup.match(/data-loading-home-activity-table=/g)).toHaveLength(1);
    expect(markup.match(/data-loading-home-activity-column=/g)).toHaveLength(6);
    expect(markup.match(/data-loading-home-activity-row=/g)).toHaveLength(6);
    expect(markup.match(/data-loading-home-mobile-activity=/g)).toHaveLength(6);
    expect(markup.match(/min-w-0 md:hidden/g)).toHaveLength(6);
    expect(markup.match(/mt-1 h-3/g)).toHaveLength(12);
    expect(markup.match(/hidden md:table-cell/g)).toHaveLength(18);
    expect(markup.match(/hidden pr-6 md:table-cell/g)).toHaveLength(7);
    expect(markup).toMatch(
      /data-loading-home-activity="true"[\s\S]*data-loading-home-activity-header="true"[\s\S]*data-loading-table="true"/
    );
    expect(markup).toContain(
      "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
    );
    expect(markup).toContain("min-w-0 [&amp;_table]:table-fixed");
    expect(markup).toContain("w-[8rem] pl-6");
    expect(markup).toContain("w-[calc(100%_-_8rem)] md:hidden");
    expect(markup.match(/hidden w-\[12rem\] md:table-cell/g)).toHaveLength(2);
    expect(markup).toContain("hidden w-[9rem] md:table-cell");
    expect(markup).toContain("hidden pr-6 md:table-cell");
    expect(markup).not.toContain('class="h-11 w-full"');
  });

  it("keeps the recurring list loader contained at a 390px viewport", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentsLoading />);

    // The Schedules list scrolls sideways inside its column, like the other refresh lists.
    expect(markup).toContain('data-loading-layout="recurring-payments"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("min-w-[760px]");
  });

  it("uses theme-aware surfaces for every authenticated loading state", () => {
    const markup = renderAuthenticatedLoadingStates();

    expect(markup).toContain("bg-surface-raised");
    expect(markup).not.toContain("bg-white");
    expect(markup).not.toMatch(/\bbg-white\//);
  });

  it("keeps only the public checkout QR well pure white", () => {
    const markup = renderToStaticMarkup(<PublicPayLoading />);

    expect(markup).toContain("bg-surface-raised");
    expect(markup.match(/bg-\[white\]/g)).toHaveLength(1);
    expect(markup).not.toContain("bg-white");
    expect(markup).not.toMatch(/\bbg-white\//);
  });
});
