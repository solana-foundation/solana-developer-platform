import { RecurringPaymentDetailSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentDetailLoading as RedesignRecurringPaymentDetailLoading } from "./loading.redesign";

export function PreviousRecurringPaymentDetailLoading() {
  return <RecurringPaymentDetailSkeleton />;
}

export default function RecurringPaymentDetailLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<RedesignRecurringPaymentDetailLoading />}
      legacy={<PreviousRecurringPaymentDetailLoading />}
    />
  );
}
