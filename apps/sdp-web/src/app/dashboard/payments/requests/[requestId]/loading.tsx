import { DesignSwitch } from "@/components/new-design";
import { PaymentRequestDetailSkeleton } from "../../payments-route-skeletons.redesign";
import { PreviousPaymentRequestsLoading as LegacyListLoading } from "../loading";

function CurrentPaymentRequestDetailLoading() {
  return <PaymentRequestDetailSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function PaymentRequestDetailLoading() {
  return (
    <DesignSwitch current={<CurrentPaymentRequestDetailLoading />} legacy={<LegacyListLoading />} />
  );
}
