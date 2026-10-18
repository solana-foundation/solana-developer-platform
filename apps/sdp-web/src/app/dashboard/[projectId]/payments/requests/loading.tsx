import { CounterpartyMenuLoading } from "@/app/dashboard/[projectId]/payments/counterparty-menu-loading";
import { DesignSwitch } from "@/components/new-design";
import { PaymentRequestsLoading as RedesignPaymentRequestsLoading } from "./loading.redesign";

export function PreviousPaymentRequestsLoading() {
  return <CounterpartyMenuLoading overview="payment-requests" />;
}

export default function PaymentRequestsLoading() {
  return (
    <DesignSwitch
      designModule="activity"
      current={<RedesignPaymentRequestsLoading />}
      legacy={<PreviousPaymentRequestsLoading />}
    />
  );
}
