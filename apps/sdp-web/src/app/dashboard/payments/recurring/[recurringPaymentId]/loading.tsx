import { DesignSwitch } from "@/components/new-design";
import { RecurringPaymentDetailSkeleton } from "../../payments-route-skeletons";
import RedesignRecurringPaymentDetailLoading from "./loading.redesign";

export function PreviousRecurringPaymentDetailLoading() {
  return <RecurringPaymentDetailSkeleton />;
}

export default function RecurringPaymentDetailLoading() {
  return (
    <DesignSwitch
      current={<RedesignRecurringPaymentDetailLoading />}
      legacy={<PreviousRecurringPaymentDetailLoading />}
    />
  );
}
