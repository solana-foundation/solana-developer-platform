import { RecurringPaymentDetailSkeleton } from "../../payments-route-skeletons";

export function PreviousRecurringPaymentDetailLoading() {
  return <RecurringPaymentDetailSkeleton />;
}

// Schedules is still the previous design's page, so it loads as one with new-design-activity on.
export default function RecurringPaymentDetailLoading() {
  return <PreviousRecurringPaymentDetailLoading />;
}
