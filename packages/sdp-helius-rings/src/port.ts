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
   * The pinned ring and its address lookup table, resolved together from the
   * ring row; present exactly when the operation is a ring-bound spend. Ring
   * transacts are v0 transactions compressed through the table. (A ring shield
   * builds from `operation.ringProgramId` alone and needs no table.)
   */
  ring?: { programId: string; lookupTable: string };
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

export interface ProvisionRingInput {
  /** Base58 program id of the pre-deployed ring program. */
  ringProgramId: string;
  /**
   * The lookup table already recorded for this ring, if any; bring-up adopts a
   * complete existing table instead of renting a second one.
   */
  lookupTableAddress?: string | null;
}

export interface ProvisionRingResult {
  /**
   * Uncompressed SEC1 P-256 auditor public key as hex, as the ring's on-chain
   * config publishes it. The caller persists it; SDP never holds the secret half.
   */
  auditorPublicKeyHex: string;
  /** The ring's address lookup table, created or adopted by bring-up. */
  lookupTableAddress: string;
}

export interface RingsGatewayPort {
  probeHealth(): Promise<RuntimeHealth>;
  provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult>;
  /**
   * Completes bring-up of a pre-deployed ring program. Idempotent against
   * on-chain state; see docs/ops/helius-rings.md for the step sequence.
   */
  provisionRing(input: ProvisionRingInput): Promise<ProvisionRingResult>;
  readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult>;
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
