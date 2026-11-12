import { reconcileFireblocksProposals } from "@/services/jobs/reconcile-fireblocks-proposals";
import { alwaysEnabled, defineCron } from "./define-cron";

export const fireblocksProposalsCron = defineCron({
  name: "reconcile-fireblocks-proposals",
  schedule: "*/30 * * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: reconcileFireblocksProposals,
});
