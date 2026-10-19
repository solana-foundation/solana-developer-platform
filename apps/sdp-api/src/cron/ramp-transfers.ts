import { reconcileRampTransfers } from "@/services/jobs/reconcile-ramp-transfers";
import { alwaysEnabled, defineCron } from "./define-cron";

// NOTE: `global` for now, on purpose. This sweep reads every Environment's rows and picks each
// row's cluster from the row itself (`row.environment`), which is correct, but it is not yet
// split into one registration per Environment like the other chain-touching crons. Moving it
// to `scope: "cluster"` is tracked in HOO-2148. New chain-touching crons use `scope: "cluster"`.
/** Ramp transfers, finished by replaying stored provider webhooks. Replay skips providers the release channel leaves out. */
export const rampTransfersCron = defineCron({
  name: "reconcile-ramp-transfers",
  schedule: "* * * * *",
  scope: "global",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileRampTransfers,
});
