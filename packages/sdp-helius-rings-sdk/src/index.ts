// Re-exported so consumers can name shielded-pool custom errors (e.g. 7009 ->
// InvalidSettlementAccounts) without pulling in @heliuslabs/zolana directly.
export { decodeShieldedPoolError } from "@heliuslabs/zolana/interface";
/**
 * The seed-derived key authority. Exported so the composition root can register
 * it in a registry beside other authorities rather than the gateway reaching for
 * it as an implicit default.
 */
export {
  createDeterministicMaterialSource,
  DETERMINISTIC_KA_SEED,
  type DerivedKeyBytes,
  deriveKeyBytes,
  warnDeterministicKeyAuthority,
} from "./deterministic-ka/index.js";
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
/**
 * The key-authority seam. A different authority is a different
 * {@link ShieldedMaterialSource}, so anything implementing one outside this
 * package builds material through `createShieldedMaterial` and lets
 * `withMaterial` destroy it.
 */
export {
  canonicalShieldedIdentity,
  createShieldedMaterial,
  isValidViewingKeyBytes,
  type MaterialRequest,
  NULLIFIER_KEY_BYTE_LENGTH,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
  VIEWING_KEY_BYTE_LENGTH,
} from "./material.js";
export {
  type OuterTransactionPolicyInput,
  type OuterTransactionPolicyIntent,
  validateOuterTransaction,
} from "./outer-tx-policy.js";
export { clearWalletCache, invalidateCachedWallet } from "./wallet-cache.js";
