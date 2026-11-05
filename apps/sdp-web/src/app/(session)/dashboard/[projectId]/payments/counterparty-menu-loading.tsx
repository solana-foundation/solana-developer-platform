import {
  CounterpartyDirectorySkeleton,
  PaymentRequestsPageSkeleton,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-route-skeletons";

type CounterpartyMenuOverview = "counterparty-directory" | "payment-requests";

/** The list skeleton for Contacts or Requests; neither page has a playground tab any more. */
export function CounterpartyMenuLoading({ overview }: { overview: CounterpartyMenuOverview }) {
  return (
    <div className="h-full min-h-0 w-full">
      {overview === "payment-requests" ? (
        <PaymentRequestsPageSkeleton />
      ) : (
        <CounterpartyDirectorySkeleton />
      )}
    </div>
  );
}

export function PaymentRequestsListLoading() {
  return <CounterpartyMenuLoading overview="payment-requests" />;
}

export function CounterpartyDirectoryLoading() {
  return <CounterpartyMenuLoading overview="counterparty-directory" />;
}
