import { DesignSwitch } from "@/components/new-design";
import LegacyRecurringPaymentCreateLoading from "../../_legacy/recurring/create/loading";
import { RecurringPaymentCreateSkeleton } from "../../payments-route-skeletons";

function CurrentRecurringPaymentCreateLoading() {
  return <RecurringPaymentCreateSkeleton />;
}

export default function RecurringPaymentCreateLoading() {
  return (
    <DesignSwitch
      current={<CurrentRecurringPaymentCreateLoading />}
      legacy={<LegacyRecurringPaymentCreateLoading />}
    />
  );
}
