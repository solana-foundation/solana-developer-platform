import { RecurringPaymentCreateSkeleton } from "../../payments-route-skeletons";

export function PreviousRecurringPaymentCreateLoading() {
  return <RecurringPaymentCreateSkeleton />;
}

// Schedules is still the previous design's page, so it loads as one with new-design-activity on.
export default function RecurringPaymentCreateLoading() {
  return <PreviousRecurringPaymentCreateLoading />;
}
