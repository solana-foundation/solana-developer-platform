import { expirePaymentRequests } from "@/services/jobs/reconcile-payment-requests";
import { alwaysEnabled, defineCron } from "./define-cron";

export const paymentRequestsExpiryCron = defineCron({
  name: "expire-payment-requests",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: expirePaymentRequests,
});
