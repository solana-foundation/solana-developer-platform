import { DesignSwitch } from "@/components/new-design";
import RedesignPaymentsLoading from "./loading.redesign";
import { PaymentsPageSkeleton } from "./payments-page-skeleton";

export function PreviousPaymentsLoading() {
  return <PaymentsPageSkeleton />;
}

export default function PaymentsLoading() {
  return (
    <DesignSwitch current={<RedesignPaymentsLoading />} legacy={<PreviousPaymentsLoading />} />
  );
}
