import { PaymentsPayPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { PayLoading as RedesignPayLoading } from "./loading.redesign";

export function PreviousPayLoading() {
  return <PaymentsPayPageSkeleton />;
}

export default function PayLoading() {
  return (
    <DesignSwitch
      designModule="payDeposit"
      current={<RedesignPayLoading />}
      legacy={<PreviousPayLoading />}
    />
  );
}
