import { DesignSwitch } from "@/components/new-design";
import { CounterpartyCreateSkeleton } from "../../payments-route-skeletons";
import RedesignCounterpartyCreateLoading from "./loading.redesign";

export function PreviousCounterpartyCreateLoading() {
  return <CounterpartyCreateSkeleton />;
}

export default function CounterpartyCreateLoading() {
  return (
    <DesignSwitch
      designModule="contacts"
      current={<RedesignCounterpartyCreateLoading />}
      legacy={<PreviousCounterpartyCreateLoading />}
    />
  );
}
