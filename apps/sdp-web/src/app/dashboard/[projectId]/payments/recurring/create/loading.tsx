import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentCreateSkeleton } from "../../payments-route-skeletons";
import RedesignRecurringPaymentCreateLoading from "./loading.redesign";

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
