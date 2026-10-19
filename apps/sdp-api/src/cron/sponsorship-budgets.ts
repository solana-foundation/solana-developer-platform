import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Kora sponsorship budgets: commits or releases fee reservations once their transactions resolve. */
export const sponsorshipBudgetsCron = defineCron({
  name: "reconcile-sponsorship-budgets",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileSponsorshipBudgets,
});
