import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentsPageSkeleton } from "../payments-route-skeletons";
import RedesignRecurringPaymentsLoading from "./loading.redesign";

export function PreviousRecurringPaymentsLoading() {
  return <RecurringPaymentsPageSkeleton />;
}

export default function RecurringPaymentsLoading() {
  return (
    <DesignSwitch
      current={<RedesignRecurringPaymentsLoading />}
      legacy={<PreviousRecurringPaymentsLoading />}
    />
  );
}
