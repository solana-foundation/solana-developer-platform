import { DesignSwitch } from "@/components/new-design";
import LegacyPayLoading from "../_legacy/pay/loading";
import { PaymentsPayPageSkeleton } from "../payments-route-skeletons";

function CurrentPayLoading() {
  return <PaymentsPayPageSkeleton />;
}

export default function PayLoading() {
  return <DesignSwitch current={<CurrentPayLoading />} legacy={<LegacyPayLoading />} />;
}
