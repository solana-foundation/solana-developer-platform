import { reconcileDvpTrades } from "@/services/jobs/reconcile-dvp-trades";
import { alwaysEnabled, defineCron } from "./define-cron";

// NOTE: DvP is not ready for launch, so its writers are deliberately left as they are for now:
// create, fund, settle, reclaim and observe-now still build on `createRpc(env)` (SOLANA_NETWORK,
// devnet everywhere), while this reconciler reads each Environment's own cluster. A
// Production-project trade, which today can only exist on devnet, would be reconciled against
// mainnet. Come back to this before DvP launches (HOO-2164): move the writers onto the project's cluster
// scope (`createClusterRpc()`), or refuse DvP on Production projects until the swap program is
// deployed on mainnet.
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
