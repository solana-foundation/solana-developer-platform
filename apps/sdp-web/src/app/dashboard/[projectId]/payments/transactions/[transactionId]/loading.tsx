import { PaymentTransactionDetailSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons.redesign";
import { PreviousTransactionsLoading as LegacyListLoading } from "@/app/dashboard/[projectId]/payments/transactions/loading";
import { DesignSwitch } from "@/components/new-design";

function CurrentTransactionDetailLoading() {
  return <PaymentTransactionDetailSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function TransactionDetailLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<CurrentTransactionDetailLoading />}
      legacy={<LegacyListLoading />}
    />
  );
}
