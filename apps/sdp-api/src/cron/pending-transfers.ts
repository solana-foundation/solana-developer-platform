import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Pending payment transfers: settles sent transfers against the chain. */
export const pendingTransfersCron = defineCron({
  name: "track-pending-transfers",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: trackPendingTransfers,
});
