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
 * The only seam between SDP and the Rings upstreams (Solana RPC, Photon,
 * prover, key authority). Behind it sits the adapter that runs the Zolana SDK
 * in process, or — until an operator configures those upstreams — a reporter
 * that names what is unset. Nothing else in the codebase may talk to those
 * upstreams directly.
 */

export interface ProvisionIdentityInput {
  walletId: string;
  sdpAddress: string;
}

export interface ProvisionIdentityResult {
  shieldedAddress: string;
  /**
   * Where the identity's keys came from. No key refs: a deterministic key
   * authority recomputes material on demand and persists none of it, so there
   * is nothing for the caller to hold on to.
   */
  materialTag: MaterialTag;
}

export interface ReadIdentityInput {
  walletId: string;
  /**
   * Base58 Solana address that owns the shielded identity. The registry keys
   * its record by owner, so the wallet id alone names no account to read.
   */
  owner: string;
}

/** Whether the registry publishes this tenant's identity for the owner. */
export type RingsIdentityStatus = "unregistered" | "ours" | "foreign";

/**
 * Which published half differs from the one this tenant derives. The same
 * values label the conflict that provisioning refuses on, so an operator reads
 * one vocabulary across both.
 */
export type RingsIdentityMismatch = "owner" | "nullifier_key" | "viewing_key";

/**
 * What the registry publishes for an owner, next to what this tenant derives.
 *
 * Only the two compressed commitments cross this seam. A record's individual
 * nullifier and viewing public keys are the published halves of a shielded
 * identity and stay behind the port; the commitment over them is the value
 * already persisted as a wallet's shielded address.
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
  /**
   * Base58 Solana address that owns the shielded identity. A gateway serves
   * every wallet in a tenant and the identity is bound to its owner, so the
   * wallet id alone does not name anything readable.
   */
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
  /**
   * True when the sync could not read everything it found. The balances are
   * still returned, so this is what stops a partial answer being read as a
   * complete one.
   */
  degraded: boolean;
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  keyRefs: KeyRef[];
  /**
   * The identity provisioning published for this wallet. Required for a shield:
   * the deposit is addressed to the derived keys, and those must still be the
   * ones the row recorded.
   */
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
   * read of the chain — one account read, no transaction, no fee — though it
   * derives key material in process, because "ours" is undefined without it.
   */
  readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult>;
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  requestProof(input: RequestProofInput): Promise<ProofArtifact>;
  /** Null while Photon has not indexed the signature yet. */
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
