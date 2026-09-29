import { DesignSwitch } from "@/components/new-design";
import LegacyCounterpartyLoading from "../_legacy/counterparty/loading";
import { CounterpartyMenuLoading } from "../counterparty-menu-loading";

function CurrentCounterpartyLoading() {
  return <CounterpartyMenuLoading overview="counterparty-directory" />;
}

export default function CounterpartyLoading() {
  return (
    <DesignSwitch current={<CurrentCounterpartyLoading />} legacy={<LegacyCounterpartyLoading />} />
  );
}
