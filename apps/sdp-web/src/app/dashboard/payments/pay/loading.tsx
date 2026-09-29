import { DesignSwitch } from "@/components/new-design";
import { PaymentsPayPageSkeleton } from "../payments-route-skeletons";
import RedesignPayLoading from "./loading.redesign";

export function PreviousPayLoading() {
  return <PaymentsPayPageSkeleton />;
}

export default function PayLoading() {
  return <DesignSwitch current={<RedesignPayLoading />} legacy={<PreviousPayLoading />} />;
}
