import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { trackPendingWithdrawals } from "@/services/jobs/track-pending-withdrawals";
import { defineCron } from "./define-cron";

// NOTE: Private Channels is EXPERIMENTAL and still being worked on. This definition is `global`
// on purpose for now: withdrawals are tracked through the instance gateway RPC, not the shared
// cluster pool, so it is not cluster-scoped yet. Do not copy this shape for a chain-touching
// cron; use `scope: "cluster"`.
//
// The one Money Exit gated by a flag: the work cannot run without the private-channels gateway
// configured, which is what `isPrivateChannelsEnabled` stands for. Pinned by the definitions
// ratchet test.
/** Private-channel withdrawal tracking. */
export const pendingWithdrawalsCron = defineCron({
  name: "track-pending-withdrawals",
  schedule: "* * * * *",
  scope: "global",
  effect: "finishes",
  enabled: isPrivateChannelsEnabled,
  run: trackPendingWithdrawals,
});
