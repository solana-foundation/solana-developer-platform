import { DesignSwitch } from "@/components/new-design";
import LegacyListLoading from "../../_legacy/transactions/loading";
import { PaymentTransactionDetailSkeleton } from "../../payments-route-skeletons";

function CurrentTransactionDetailLoading() {
  return <PaymentTransactionDetailSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function TransactionDetailLoading() {
  return (
    <DesignSwitch current={<CurrentTransactionDetailLoading />} legacy={<LegacyListLoading />} />
  );
}
