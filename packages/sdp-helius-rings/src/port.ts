import type { SecretRef } from "./secrets";
import type {
  AssetBalance,
  KeyRef,
  MaterialTag,
  PrivateOperation,
  ProofArtifact,
  RuntimeHealth,
} from "./types";

/**
 * The only seam between SDP and the Rings upstreams (Solana RPC, Photon, prover,
 * key authority). Nothing else in the codebase may talk to those upstreams
 * directly.
 */

export interface ProvisionIdentityInput {
  walletId: string;
  sdpAddress: string;
}

export interface ProvisionIdentityResult {
  shieldedAddress: string;
  /** No key refs: a deterministic key authority persists none of its material. */
  materialTag: MaterialTag;
}

export interface ReadIdentityInput {
  walletId: string;
  /** Base58 owner address; the registry keys its record by owner, not by wallet id. */
  owner: string;
}

/** Whether the registry publishes this tenant's identity for the owner. */
export type RingsIdentityStatus = "unregistered" | "ours" | "foreign";

/** Which published half differs; the same values label the conflict provisioning refuses on. */
export type RingsIdentityMismatch = "owner" | "nullifier_key" | "viewing_key";

/**
 * What the registry publishes for an owner, next to what this tenant derives.
 * Only the two compressed commitments cross this seam; a record's individual
 * nullifier and viewing public keys stay behind the port.
 */
export interface ReadIdentityResult {
  status: RingsIdentityStatus;
  /** Canonical shielded address this tenant derives for the wallet. */
  derivedShieldedAddress: string;
  /** Canonical shielded address the registry publishes; null when unregistered. */
  publishedShieldedAddress: string | null;
  /** Null unless `status` is `foreign`. */
  mismatch: RingsIdentityMismatch | null;
}

export interface SyncPhotonInput {
  walletId: string;
  /** Base58 owner address; the identity is bound to its owner, not to the wallet id. */
  owner: string;
  /** Null on the first sync. */
  cursor: string | null;
  /** The identity provisioning published, when known. A mismatch fails closed. */
  expectedShieldedAddress?: string;
}

export interface SyncPhotonResult {
  cursor: string;
  /** The domain type rather than its shape, so the two cannot drift on `decimals`. */
  balances: AssetBalance[];
  /** Outer tx signatures Photon has indexed since the previous cursor. */
  indexedOperationSignatures: string[];
  /** The balances are still returned, so this is what stops a partial answer reading as complete. */
  degraded: boolean;
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  keyRefs: KeyRef[];
  /** Required for a shield: the deposit is addressed to the derived keys. */
  expectedShieldedAddress?: string;
}

export interface BuildOperationResult {
  outerUnsignedTxBase64: string;
  requiredSigners: string[];
  /** Opaque gateway state carried into requestProof; never logged or persisted raw. */
  ringsMetadata: SecretRef<Record<string, unknown>>;
}

export interface RequestProofInput {
  operationId: string;
  ringsMetadata: SecretRef<Record<string, unknown>>;
}

export interface VerifyIndexedResult {
  indexedAt: string;
  photonRef: string;
}

export interface RingsGatewayPort {
  probeHealth(): Promise<RuntimeHealth>;
  provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult>;
  /**
   * Reads the published identity and says whether it is this tenant's. A pure
   * read of the chain, though it derives key material in process.
   */
  readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult>;
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  requestProof(input: RequestProofInput): Promise<ProofArtifact>;
  /** Null while Photon has not indexed the signature yet. */
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
