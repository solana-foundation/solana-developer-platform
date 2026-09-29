import { DesignSwitch } from "@/components/new-design";
import LegacyPaymentsLoading from "./_legacy/loading";
import { PaymentsPageSkeleton } from "./payments-page-skeleton";

function CurrentPaymentsLoading() {
  return <PaymentsPageSkeleton />;
}

export default function PaymentsLoading() {
  return <DesignSwitch current={<CurrentPaymentsLoading />} legacy={<LegacyPaymentsLoading />} />;
}
