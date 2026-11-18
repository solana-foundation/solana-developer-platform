import { reconcilePendingProposals } from "@/services/jobs/reconcile-pending-proposals";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Provider proposals reconcile independently of chain transfer settlement. */
export const custodyProposalsCron = defineCron({
  name: "reconcile-custody-proposals",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: (env) => reconcilePendingProposals(env),
});
