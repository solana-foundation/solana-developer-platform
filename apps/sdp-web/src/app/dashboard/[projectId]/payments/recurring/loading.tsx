import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentsPageSkeleton } from "../payments-route-skeletons";
import RedesignRecurringPaymentsLoading from "./loading.redesign";

export function PreviousRecurringPaymentsLoading() {
  return <RecurringPaymentsPageSkeleton />;
}

export default function RecurringPaymentsLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<RedesignRecurringPaymentsLoading />}
      legacy={<PreviousRecurringPaymentsLoading />}
    />
  );
}
