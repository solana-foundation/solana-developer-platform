import { CounterpartyMenuLoading } from "../counterparty-menu-loading";

export function PreviousPaymentRequestsLoading() {
  return <CounterpartyMenuLoading overview="payment-requests" />;
}

// Requests is still the previous design's page, so it loads as one with new-design-activity on.
export default function PaymentRequestsLoading() {
  return <PreviousPaymentRequestsLoading />;
}
