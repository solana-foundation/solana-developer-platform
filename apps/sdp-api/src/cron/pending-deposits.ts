import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { trackPendingDeposits } from "@/services/jobs/track-pending-deposits";
import { defineCron } from "./define-cron";

// NOTE: Private Channels is EXPERIMENTAL and still being worked on. This definition is `global`
// on purpose for now: deposits are observed through the project's configured private-channels
// RPC, not the shared cluster pool, so it is not cluster-scoped yet. Do not copy this shape for
// a chain-touching cron; use `scope: "cluster"`.
/** Private-channel deposit observation. */
export const pendingDepositsCron = defineCron({
  name: "track-pending-deposits",
  schedule: "* * * * *",
  scope: "global",
  effect: "observes",
  enabled: isPrivateChannelsEnabled,
  run: trackPendingDeposits,
});
