import { DesignSwitch } from "@/components/new-design";
import LegacyTransactionsLoading from "../_legacy/transactions/loading";
import { PaymentsTransactionsPageSkeleton } from "../payments-route-skeletons";

function CurrentTransactionsLoading() {
  return <PaymentsTransactionsPageSkeleton />;
}

export default function TransactionsLoading() {
  return (
    <DesignSwitch current={<CurrentTransactionsLoading />} legacy={<LegacyTransactionsLoading />} />
  );
}
