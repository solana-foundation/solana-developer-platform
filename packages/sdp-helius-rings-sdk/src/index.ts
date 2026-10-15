// Re-exported so consumers can name shielded-pool custom errors (e.g. 7009 ->
// InvalidSettlementAccounts) without pulling in @heliuslabs/zolana directly.
export { decodeShieldedPoolError } from "@heliuslabs/zolana/interface";
/**
 * The exact bytes an owner signs to root its shielded keys. Exported so a
 * custody signer can tell the derivation signature, which every exit needs,
 * from any other message it is asked to sign.
 */
export { derivationMessageBase64 } from "./custody-ka/seed.js";
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
