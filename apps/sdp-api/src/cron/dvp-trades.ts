import { reconcileDvpTrades } from "@/services/jobs/reconcile-dvp-trades";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Open DvP trades against the chain. Always on: an open trade holds a counterparty's money in
 * escrow, so it keeps being settled whatever the Markets flag says. Outside the release channel
 * it simply finds no trades.
 */
export const dvpTradesCron = defineCron({
  name: "reconcile-dvp-trades",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileDvpTrades,
});
