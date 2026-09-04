// Re-exported so consumers can name shielded-pool custom errors (e.g. 7009 ->
// InvalidSettlementAccounts) without pulling in @heliuslabs/zolana directly.
export { decodeShieldedPoolError } from "@heliuslabs/zolana/interface";
export { createRingsGateway, type RingsGatewayConfig } from "./gateway.js";
export {
  type OuterTransactionPolicyInput,
  type OuterTransactionPolicyIntent,
  validateOuterTransaction,
} from "./outer-tx-policy.js";
export { clearWalletCache, invalidateCachedWallet } from "./wallet-cache.js";
