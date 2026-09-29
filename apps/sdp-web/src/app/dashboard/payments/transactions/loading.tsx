import { DesignSwitch } from "@/components/new-design";
import { PaymentsTransactionsPageSkeleton } from "../payments-route-skeletons";
import RedesignTransactionsLoading from "./loading.redesign";

export function PreviousTransactionsLoading() {
  return <PaymentsTransactionsPageSkeleton />;
}

export default function TransactionsLoading() {
  return (
    <DesignSwitch
      current={<RedesignTransactionsLoading />}
      legacy={<PreviousTransactionsLoading />}
    />
  );
}
