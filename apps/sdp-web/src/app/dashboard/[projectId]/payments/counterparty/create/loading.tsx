import { CounterpartyCreateSkeleton } from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import { DesignSwitch } from "@/components/new-design";
import { CounterpartyCreateLoading as RedesignCounterpartyCreateLoading } from "./loading.redesign";

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
