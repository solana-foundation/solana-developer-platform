import { DesignSwitch } from "@/components/new-design";
import LegacyCounterpartyDetailLoading from "../../_legacy/counterparty/[counterpartyId]/loading";
import { CounterpartyDetailSkeleton } from "../../payments-route-skeletons";

function CurrentCounterpartyDetailLoading() {
  return <CounterpartyDetailSkeleton />;
}

export default function CounterpartyDetailLoading() {
  return (
    <DesignSwitch
      current={<CurrentCounterpartyDetailLoading />}
      legacy={<LegacyCounterpartyDetailLoading />}
    />
  );
}
