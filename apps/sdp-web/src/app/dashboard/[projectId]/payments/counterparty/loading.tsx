import { DesignSwitch } from "@/components/new-design";
import { CounterpartyMenuLoading } from "../counterparty-menu-loading";
import RedesignCounterpartyLoading from "./loading.redesign";

export function PreviousCounterpartyLoading() {
  return <CounterpartyMenuLoading overview="counterparty-directory" />;
}

export default function CounterpartyLoading() {
  return (
    <DesignSwitch
      designModule="contacts"
      current={<RedesignCounterpartyLoading />}
      legacy={<PreviousCounterpartyLoading />}
    />
  );
}
