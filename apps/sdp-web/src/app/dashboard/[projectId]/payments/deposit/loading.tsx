import { DesignSwitch } from "@/components/new-design";
import { PaymentsDepositPageSkeleton } from "../payments-route-skeletons";
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
