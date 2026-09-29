import { DesignSwitch } from "@/components/new-design";
import LegacyPaymentRequestsLoading from "../_legacy/requests/loading";
import { CounterpartyMenuLoading } from "../counterparty-menu-loading";

function CurrentPaymentRequestsLoading() {
  return <CounterpartyMenuLoading overview="payment-requests" />;
}

export default function PaymentRequestsLoading() {
  return (
    <DesignSwitch
      current={<CurrentPaymentRequestsLoading />}
      legacy={<LegacyPaymentRequestsLoading />}
    />
  );
}
