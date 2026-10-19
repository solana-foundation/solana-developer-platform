import { PaymentRequestDetailSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons.redesign";
import { PreviousPaymentRequestsLoading as LegacyListLoading } from "@/app/dashboard/[projectId]/payments/requests/loading";
import { DesignSwitch } from "@/components/new-design";

function CurrentPaymentRequestDetailLoading() {
  return <PaymentRequestDetailSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function PaymentRequestDetailLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<CurrentPaymentRequestDetailLoading />}
      legacy={<LegacyListLoading />}
    />
  );
}
