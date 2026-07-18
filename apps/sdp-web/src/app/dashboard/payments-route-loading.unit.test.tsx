import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PublicPayLoading from "../pay/[token]/loading";
import DashboardLoading from "./loading";
import CounterpartyDetailLoading from "./payments/counterparty/[counterpartyId]/loading";
import CounterpartyCreateLoading from "./payments/counterparty/create/loading";
import CounterpartyLoading from "./payments/counterparty/loading";
import { CounterpartyPlaygroundLoading } from "./payments/counterparty-menu-loading";
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
import TransactionsLoading from "./payments/transactions/loading";

const dashboardWorkspaceMock = vi.hoisted(() => ({
  counterpartyTab: "overview" as "overview" | "playground",
}));

vi.mock("@/contexts/dashboard-workspace-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/dashboard-workspace-context")>();
  return {
    ...actual,
    useDashboardWorkspace: () => dashboardWorkspaceMock,
  };
});

const EXPECTED_ROUTE_LAYOUTS = [
  "home",
  "payments-overview",
  "payments-transactions",
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

function renderAuthenticatedLoadingStates(): string {
  return renderToStaticMarkup(
    <>
      <DashboardLoading />
      <PaymentsLoading />
      <PayLoading />
      <DepositLoading />
      <PaymentRequestsLoading />
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
    dashboardWorkspaceMock.counterpartyTab = "overview";
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
    expect(markup.match(/data-loading-detail-rows/g)).toHaveLength(2);
    expect(markup).toContain("lg:grid-cols-2");
    expect(markup).toContain("size-[208px]");
  });

  it("matches each settled route's native table columns and responsive visibility", () => {
    const tableCases = [
      {
        layout: "payment-requests",
        markup: renderToStaticMarkup(<PaymentRequestsPageSkeleton />),
        columnClasses: ["w-[16%]", "w-[20%]", "w-[22%]", "w-[22%]", "w-[20%]"],
      },
      {
        layout: "counterparty-directory",
        markup: renderToStaticMarkup(<CounterpartyDirectorySkeleton />),
        columnClasses: ["w-[30%]", "w-[12%]", "w-[24%]", "w-[16%]", "w-[18%]", "w-[56px]"],
      },
      {
        layout: "recurring-payments",
        markup: renderToStaticMarkup(<RecurringPaymentsPageSkeleton />),
        columnClasses: [
          "w-[34%] md:w-[26%] lg:w-[21%] xl:w-[18%]",
          "w-[26%] md:w-[22%] lg:w-[20%] xl:w-[18%]",
          "w-[40%] md:w-[34%] lg:w-[31%] xl:w-[24%]",
          "hidden lg:table-cell lg:w-[28%] xl:w-[22%]",
          "hidden xl:table-cell xl:w-[18%]",
          "hidden md:table-cell md:w-[18%] xl:hidden 2xl:table-cell 2xl:w-[18%]",
        ],
      },
    ];

    for (const { layout, markup, columnClasses } of tableCases) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
      expect(markup).toContain(`data-loading-table-variant="${layout}"`);
      expect(markup.match(/data-loading-column=/g)).toHaveLength(columnClasses.length);
      expect(markup.match(/data-loading-table-row=/g)).toHaveLength(5);
      expect(markup).toContain("[&amp;_table]:table-fixed");
      for (const className of columnClasses) {
        expect(markup).toContain(className);
      }
    }

    expect(tableCases.map(({ markup }) => markup).join("")).not.toContain(
      "data-loading-mobile-rows"
    );
  });

  it("keeps counterparty menu loading aligned with the selected tab", () => {
    dashboardWorkspaceMock.counterpartyTab = "playground";

    const expectedPlayground = renderToStaticMarkup(<CounterpartyPlaygroundLoading />);
    expect(renderToStaticMarkup(<CounterpartyLoading />)).toBe(expectedPlayground);
    expect(renderToStaticMarkup(<PaymentRequestsLoading />)).toBe(expectedPlayground);
    expect(expectedPlayground).toContain('data-loading-layout="counterparty-playground"');

    dashboardWorkspaceMock.counterpartyTab = "overview";
    expect(renderToStaticMarkup(<CounterpartyLoading />)).toContain(
      'data-loading-layout="counterparty-directory"'
    );
    expect(renderToStaticMarkup(<PaymentRequestsLoading />)).toContain(
      'data-loading-layout="payment-requests"'
    );
  });

  it("matches the initial counterparty picker in every payment wizard", () => {
    const wizardCases = [
      ["payments-pay", renderToStaticMarkup(<PaymentsPayPageSkeleton />)],
      ["payments-deposit", renderToStaticMarkup(<PaymentsDepositPageSkeleton />)],
      ["recurring-payment-create", renderToStaticMarkup(<RecurringPaymentCreateSkeleton />)],
    ];

    for (const [layout, markup] of wizardCases) {
      expect(markup).toContain(`data-loading-layout="${layout}"`);
      expect(markup.match(/data-loading-counterparty-picker=/g)).toHaveLength(1);
      expect(markup.match(/data-loading-add-counterparty=/g)).toHaveLength(1);
      expect(markup.match(/data-loading-combobox=/g)).toHaveLength(1);
      expect(markup).toContain("border-dashed");
      expect(markup).toContain("h-[var(--input-height-xl)]");
      expect(markup).toContain("rounded-[var(--input-radius-xl)]");
      expect(markup).not.toContain("data-loading-option");
      expect(markup).not.toContain("min-h-16");
    }
  });

  it("keeps recurring detail scrollable while its data is pending", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentDetailSkeleton />);

    expect(markup).toContain('data-loading-layout="recurring-payment-detail"');
    expect(markup).toContain("overflow-auto");
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
    expect(markup.match(/hidden w-\[10rem\] md:table-cell/g)).toHaveLength(2);
    expect(markup).toContain("hidden w-[8rem] md:table-cell");
    expect(markup).toContain("hidden pr-6 md:table-cell");
    expect(markup).not.toContain('class="h-11 w-full"');
  });

  it("keeps the recurring list loader contained at a 390px viewport", () => {
    const markup = renderToStaticMarkup(<RecurringPaymentsLoading />);

    expect(markup).toContain("flex min-w-0 flex-col gap-4 sm:grid");
    expect(markup).toContain("h-full min-h-0 min-w-0 flex-col");
    expect(markup).toContain("flex min-h-0 min-w-0 flex-1 flex-col");
    expect(markup).toContain("table-scroll-container overflow-x-auto");
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
