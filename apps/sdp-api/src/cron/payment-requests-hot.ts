import { reconcileHotPaymentRequests } from "@/services/jobs/reconcile-payment-requests";
import { alwaysEnabled, defineCron } from "./define-cron";

export const paymentRequestsHotCron = defineCron({
  name: "reconcile-payment-requests-hot",
  schedule: "*/30 * * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: reconcileHotPaymentRequests,
});
