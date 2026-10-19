import { RecurringPaymentsPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentsLoading as RedesignRecurringPaymentsLoading } from "./loading.redesign";

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
