import { DesignSwitch } from "@/components/new-design";
import { PaymentTransactionDetailSkeleton } from "../../payments-route-skeletons.redesign";
import { PreviousTransactionsLoading as LegacyListLoading } from "../loading";

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
