import { DesignSwitch } from "@/components/new-design";
import LegacyListLoading from "../../_legacy/requests/loading";
import { PaymentRequestDetailSkeleton } from "../../payments-route-skeletons";

function CurrentPaymentRequestDetailLoading() {
  return <PaymentRequestDetailSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function PaymentRequestDetailLoading() {
  return (
    <DesignSwitch current={<CurrentPaymentRequestDetailLoading />} legacy={<LegacyListLoading />} />
  );
}
