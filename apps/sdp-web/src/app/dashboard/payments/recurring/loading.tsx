import { RecurringPaymentsPageSkeleton } from "../payments-route-skeletons";

export function PreviousRecurringPaymentsLoading() {
  return <RecurringPaymentsPageSkeleton />;
}

// Schedules is still the previous design's page, so it loads as one with new-design-activity on.
export default function RecurringPaymentsLoading() {
  return <PreviousRecurringPaymentsLoading />;
}
