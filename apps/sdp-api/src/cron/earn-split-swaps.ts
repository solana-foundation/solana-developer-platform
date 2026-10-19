import { detectOrphanedEarnSplitSwaps } from "@/services/jobs/detect-orphaned-earn-split-swaps";
import { alwaysEnabled, defineCron } from "./define-cron";

// NOTE: `global` for now, on purpose. This sweep reads every Environment's rows and picks each
// row's cluster from the row itself (`row.environment`), which is correct, but it is not yet
// split into one registration per Environment like the other chain-touching crons. Moving it
// to `scope: "cluster"` is tracked in HOO-2148. New chain-touching crons use `scope: "cluster"`.
/**
 * Orphaned split-swap detection (PRO-1864, threat model EARN-026): the advisory sweep over swaps
 * SDP handed to a partner but never saw deposited. Always on: an advisory written before an
 * incident flag flip must keep being watched.
 */
export const earnSplitSwapsCron = defineCron({
  name: "detect-orphaned-earn-split-swaps",
  schedule: "* * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: detectOrphanedEarnSplitSwaps,
});
