import { DesignSwitch } from "@/components/new-design";
import LegacyRecurringPaymentDetailLoading from "../../_legacy/recurring/[recurringPaymentId]/loading";
import { RecurringPaymentDetailSkeleton } from "../../payments-route-skeletons";

function CurrentRecurringPaymentDetailLoading() {
  return <RecurringPaymentDetailSkeleton />;
}

export default function RecurringPaymentDetailLoading() {
  return (
    <DesignSwitch
      current={<CurrentRecurringPaymentDetailLoading />}
      legacy={<LegacyRecurringPaymentDetailLoading />}
    />
  );
}
