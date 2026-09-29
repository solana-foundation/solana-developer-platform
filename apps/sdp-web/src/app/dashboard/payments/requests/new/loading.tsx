import { DesignSwitch } from "@/components/new-design";
import LegacyListLoading from "../../_legacy/requests/loading";
import { PaymentRequestCreateSkeleton } from "../../payments-route-skeletons";

function CurrentPaymentRequestCreateLoading() {
  return <PaymentRequestCreateSkeleton />;
}

// The previous design sends this route to the list, so it loads as the list does.
export default function PaymentRequestCreateLoading() {
  return (
    <DesignSwitch current={<CurrentPaymentRequestCreateLoading />} legacy={<LegacyListLoading />} />
  );
}
