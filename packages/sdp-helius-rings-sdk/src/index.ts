// Re-exported so consumers can name shielded-pool custom errors (e.g. 7009 ->
// InvalidSettlementAccounts) and the user-registry program the wire format is
// pinned to, without pulling in @heliuslabs/zolana directly.

export { USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/zolana";
export { decodeShieldedPoolError } from "@heliuslabs/zolana/interface";
/**
 * The assets a spend may name, as SDP spells them. Exported so the route
 * schema refuses the same set the builders and the wire policy do, instead of
 * keeping its own copy of the literals to drift from.
 */
export { SDP_NATIVE_MINT, SDP_USDC_MINT } from "./flows/mint.js";
export { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";
export {
  type ProbeOutcome,
  probeRingRpcHealth,
  type RingRpcHealthInput,
} from "./health.js";
export {
  type OuterTransactionPolicyInput,
  type OuterTransactionPolicyIntent,
  validateOuterTransaction,
} from "./outer-tx-policy.js";
export { clearWalletCache, invalidateCachedWallet } from "./wallet-cache.js";
