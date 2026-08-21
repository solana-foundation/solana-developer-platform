import type { SecretRef } from "./secrets";
import type { KeyRef, PrivateOperation, ProofArtifact, RuntimeHealth } from "./types";

/**
 * The only seam between SDP and the Rings upstreams (Zolana sidecar, Photon,
 * prover, key authority). Track A ships NotImplementedRingsGateway behind it;
 * Track B replaces that with the live HTTP adapter. Nothing else in the
 * codebase may talk to those upstreams directly.
 */

export interface ProvisionIdentityInput {
  walletId: string;
  sdpAddress: string;
}

export interface ProvisionIdentityResult {
  shieldedAddress: string;
  keyRefs: KeyRef[];
}

export interface SyncPhotonInput {
  walletId: string;
  /** Null on the first sync. */
  cursor: string | null;
}

export interface SyncPhotonResult {
  cursor: string;
  balances: Array<{ mint: string; amountRaw: string; decimals: number; symbol: string }>;
  /** Outer tx signatures Photon has indexed since the previous cursor. */
  indexedOperationSignatures: string[];
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  keyRefs: KeyRef[];
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
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  requestProof(input: RequestProofInput): Promise<ProofArtifact>;
  /** Null while Photon has not indexed the signature yet. */
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
