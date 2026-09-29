import { DesignSwitch } from "@/components/new-design";
import LegacyRecurringPaymentsLoading from "../_legacy/recurring/loading";
import { RecurringPaymentsPageSkeleton } from "../payments-route-skeletons";

function CurrentRecurringPaymentsLoading() {
  return <RecurringPaymentsPageSkeleton />;
}

export default function RecurringPaymentsLoading() {
  return (
    <DesignSwitch
      current={<CurrentRecurringPaymentsLoading />}
      legacy={<LegacyRecurringPaymentsLoading />}
    />
  );
}
