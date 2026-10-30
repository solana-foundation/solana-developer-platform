import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { trackPendingDeposits } from "@/services/jobs/track-pending-deposits";
import { defineCron } from "./define-cron";

/** Private-channel deposit observation, once per Environment, through its cluster pool. */
export const pendingDepositsCron = defineCron({
  name: "track-pending-deposits",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: isPrivateChannelsEnabled,
  run: trackPendingDeposits,
});
