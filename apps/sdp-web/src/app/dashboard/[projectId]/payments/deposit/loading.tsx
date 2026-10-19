import { PaymentsDepositPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { DepositLoading as RedesignDepositLoading } from "./loading.redesign";

export function PreviousDepositLoading() {
  return <PaymentsDepositPageSkeleton />;
}

export default function DepositLoading() {
  return (
    <DesignSwitch
      designModule="payDeposit"
      current={<RedesignDepositLoading />}
      legacy={<PreviousDepositLoading />}
    />
  );
}
