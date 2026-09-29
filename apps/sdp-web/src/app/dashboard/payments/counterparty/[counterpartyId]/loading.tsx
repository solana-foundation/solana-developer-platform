import { DesignSwitch } from "@/components/new-design";
import { CounterpartyDetailSkeleton } from "../../payments-route-skeletons";
import RedesignCounterpartyDetailLoading from "./loading.redesign";

export function PreviousCounterpartyDetailLoading() {
  return <CounterpartyDetailSkeleton />;
}

export default function CounterpartyDetailLoading() {
  return (
    <DesignSwitch
      current={<RedesignCounterpartyDetailLoading />}
      legacy={<PreviousCounterpartyDetailLoading />}
    />
  );
}
