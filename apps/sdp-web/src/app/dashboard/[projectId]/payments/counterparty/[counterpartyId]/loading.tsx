import { CounterpartyDetailSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { CounterpartyDetailLoading as RedesignCounterpartyDetailLoading } from "./loading.redesign";

export function PreviousCounterpartyDetailLoading() {
  return <CounterpartyDetailSkeleton />;
}

export default function CounterpartyDetailLoading() {
  return (
    <DesignSwitch
      designModule="contacts"
      current={<RedesignCounterpartyDetailLoading />}
      legacy={<PreviousCounterpartyDetailLoading />}
    />
  );
}
