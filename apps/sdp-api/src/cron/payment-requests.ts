import { reconcilePaymentRequests } from "@/services/jobs/reconcile-payment-requests";
import { alwaysEnabled, defineCron } from "./define-cron";

export const paymentRequestsCron = defineCron({
  name: "reconcile-payment-requests",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: reconcilePaymentRequests,
});
