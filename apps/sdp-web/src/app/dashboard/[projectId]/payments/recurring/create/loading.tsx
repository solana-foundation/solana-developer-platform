import { RecurringPaymentCreateSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentCreateLoading as RedesignRecurringPaymentCreateLoading } from "./loading.redesign";

export function PreviousRecurringPaymentCreateLoading() {
  return <RecurringPaymentCreateSkeleton />;
}

export default function RecurringPaymentCreateLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<RedesignRecurringPaymentCreateLoading />}
      legacy={<PreviousRecurringPaymentCreateLoading />}
    />
  );
}
