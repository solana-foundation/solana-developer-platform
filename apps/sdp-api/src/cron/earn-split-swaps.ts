import { detectOrphanedEarnSplitSwaps } from "@/services/jobs/detect-orphaned-earn-split-swaps";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Orphaned split-swap detection (PRO-1864, threat model EARN-026): the advisory sweep over swaps
 * SDP handed to a partner but never saw deposited, each Environment's advisories on its own
 * cluster. Always on: an advisory written before an incident flag flip must keep being watched.
 */
export const earnSplitSwapsCron = defineCron({
  name: "detect-orphaned-earn-split-swaps",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: detectOrphanedEarnSplitSwaps,
});
