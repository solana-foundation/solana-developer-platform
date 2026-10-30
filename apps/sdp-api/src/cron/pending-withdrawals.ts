import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { trackPendingWithdrawals } from "@/services/jobs/track-pending-withdrawals";
import { defineCron } from "./define-cron";

// The one Money Exit gated by a flag: the work cannot run without the private-channels gateway
// configured, which is what `isPrivateChannelsEnabled` stands for. Pinned by the definitions
// ratchet test.
/**
 * Private-channel withdrawal tracking, once per Environment: burns are read through each
 * instance's gateway, releases through the Environment's cluster pool.
 */
export const pendingWithdrawalsCron = defineCron({
  name: "track-pending-withdrawals",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: isPrivateChannelsEnabled,
  run: trackPendingWithdrawals,
});
