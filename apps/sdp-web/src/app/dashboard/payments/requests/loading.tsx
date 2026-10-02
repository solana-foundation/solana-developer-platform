import { DesignSwitch } from "@/components/new-design";
import { CounterpartyMenuLoading } from "../counterparty-menu-loading";
import RedesignPaymentRequestsLoading from "./loading.redesign";

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
