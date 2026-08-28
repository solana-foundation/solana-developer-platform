import type {
  AssetBalance,
  MaterialTag,
  PrivateHistoryEntry,
  PrivateOperation,
  ProofArtifact,
  RuntimeHealth,
  SyncReport,
} from "./types";

/**
 * The only seam between SDP and the Rings upstreams. Every type crossing it is
 * a plain DTO so Kit 6 and Kit 7 cannot silently mismatch across the boundary.
 */

export interface ShieldedIdentity {
  shieldedAddress: string;
  owner: string;
}

export interface ProvisionIdentityInput {
  walletId: string;
  sdpAddress: string;
}

export interface ProvisionIdentityResult {
  identity: ShieldedIdentity;
  registrationSignatures: string[];
  mergingEnabled: boolean;
  materialTag: MaterialTag;
}

export interface ReadIdentityInput {
  walletId: string;
  owner: string;
}

export type RingsIdentityStatus = "unregistered" | "ours" | "foreign";
export type RingsIdentityMismatch = "owner" | "nullifier_key" | "viewing_key";

export interface ReadIdentityResult {
  status: RingsIdentityStatus;
  derivedShieldedAddress: string;
  publishedShieldedAddress: string | null;
  mismatch: RingsIdentityMismatch | null;
}

export interface KnownAsset {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface SyncPhotonInput {
  walletId: string;
  owner: string;
  expectedShieldedAddress?: string;
  knownAssets?: KnownAsset[];
  /** uint64 slot string the indexer must reach before the read is trusted. */
  requireSlot?: string;
}

export interface SyncPhotonResult {
  balances: AssetBalance[];
  history: PrivateHistoryEntry[];
  report: SyncReport;
  indexedOperationSignatures: string[];
  observedAt: string;
  observedSlot?: string;
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  owner: string;
  expectedShieldedAddress?: string;
  pinnedInputs?: string[];
  knownAssets?: KnownAsset[];
  requireSlot?: string;
  /**
   * Present only for private transfers: identifies the recipient wallet so the
   * SDK can load its material and derive the ShieldedAddress needed to build the
   * transfer output. Same tenant as the sender is enforced upstream.
   */
  recipient?: {
    walletId: string;
    owner: string;
    expectedShieldedAddress: string;
  };
}

export interface BuildOperationResult {
  outerUnsignedTxBase64: string;
  requiredSigners: string[];
  lastValidBlockHeight: string;
  inputNotes: string[];
  proof: ProofArtifact;
}

export interface VerifyIndexedResult {
  indexedAt: string;
  photonRef: string;
  slot: string;
}

export interface RingsGatewayPort {
  probeHealth(): Promise<RuntimeHealth>;
  provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult>;
  readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult>;
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
