import { reconcilePaymentRequests } from "@/services/jobs/reconcile-payment-requests";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Payment requests: settles open requests whose payment has finalized on chain. */
export const paymentRequestsCron = defineCron({
  name: "reconcile-payment-requests",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: reconcilePaymentRequests,
});
