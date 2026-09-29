import { DesignSwitch } from "@/components/new-design";
import LegacyCounterpartyCreateLoading from "../../_legacy/counterparty/create/loading";
import { CounterpartyCreateSkeleton } from "../../payments-route-skeletons";

function CurrentCounterpartyCreateLoading() {
  return <CounterpartyCreateSkeleton />;
}

export default function CounterpartyCreateLoading() {
  return (
    <DesignSwitch
      current={<CurrentCounterpartyCreateLoading />}
      legacy={<LegacyCounterpartyCreateLoading />}
    />
  );
}
