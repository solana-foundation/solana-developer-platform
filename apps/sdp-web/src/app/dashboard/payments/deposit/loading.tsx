import { DesignSwitch } from "@/components/new-design";
import LegacyDepositLoading from "../_legacy/deposit/loading";
import { PaymentsDepositPageSkeleton } from "../payments-route-skeletons";

function CurrentDepositLoading() {
  return <PaymentsDepositPageSkeleton />;
}

export default function DepositLoading() {
  return <DesignSwitch current={<CurrentDepositLoading />} legacy={<LegacyDepositLoading />} />;
}
