import { PaymentsTransactionsPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { TransactionsLoading as RedesignTransactionsLoading } from "./loading.redesign";

export function PreviousTransactionsLoading() {
  return <PaymentsTransactionsPageSkeleton />;
}

export default function TransactionsLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<RedesignTransactionsLoading />}
      legacy={<PreviousTransactionsLoading />}
    />
  );
}
