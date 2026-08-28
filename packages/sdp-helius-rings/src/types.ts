import type {
  FAILURE_CODES,
  KEY_KINDS,
  MATERIAL_TAGS,
  OP_TYPES,
  OPERATION_STATES,
  PRIVATE_HISTORY_DIRECTIONS,
  PRIVATE_HISTORY_KINDS,
  RUNTIME_HEALTH_COMPONENTS,
  RUNTIME_HEALTH_STATUSES,
  TRANSFER_MODES,
  WALLET_STATUSES,
  ZONE_KINDS,
} from "./constants";
import type { SecretRef } from "./secrets";

export type OperationState = (typeof OPERATION_STATES)[number];
export type OpType = (typeof OP_TYPES)[number];
export type FailureCode = (typeof FAILURE_CODES)[number];
export type KeyKind = (typeof KEY_KINDS)[number];
export type MaterialTag = (typeof MATERIAL_TAGS)[number];
export type PrivateHistoryKind = (typeof PRIVATE_HISTORY_KINDS)[number];
export type PrivateHistoryDirection = (typeof PRIVATE_HISTORY_DIRECTIONS)[number];
export type RuntimeHealthStatus = (typeof RUNTIME_HEALTH_STATUSES)[number];
export type RuntimeHealthComponent = (typeof RUNTIME_HEALTH_COMPONENTS)[number];
export type WalletStatus = (typeof WALLET_STATUSES)[number];
export type ZoneKind = (typeof ZONE_KINDS)[number];
export type TransferMode = (typeof TRANSFER_MODES)[number];

export interface ProofArtifact {
  source: MaterialTag;
  ref: SecretRef<string>;
  createdAt: string;
}

export interface KeyRef {
  kind: KeyKind;
  material: SecretRef<Uint8Array>;
  materialTag: MaterialTag;
  keyVersion: string;
}

export interface PrivateWallet {
  id: string;
  sdpWalletId: string;
  name: string;
  shieldedAddress: string | null;
  status: WalletStatus;
  network: "devnet";
  syncCursor: string | null;
  materialTag: MaterialTag;
}

export type RuntimeHealth = Record<RuntimeHealthComponent, RuntimeHealthStatus> & {
  detail?: Record<string, string>;
};

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
}

export interface AssetBalance {
  mint: string;
  symbol: string;
  amountRaw: string;
  decimals: number | null;
}

export interface PrivateHistoryEntry {
  signature: string;
  slot: string;
  index: string;
  kind: PrivateHistoryKind;
  direction: PrivateHistoryDirection;
  mint: string;
  amountRaw: string;
}

export interface SyncReport {
  storedNotes: number;
  unparsedTransactions: number;
  undecryptableCandidates: number;
  unknownAssetIds: number;
  unknownAssetFields: number;
  degraded: boolean;
}

export interface PrivateOperationSummary {
  id: string;
  walletId: string;
  opType: OpType;
  state: OperationState;
  assetMint: string | null;
  amountRaw: string | null;
  createdAt: string;
  updatedAt: string;
  failureCode: FailureCode | null;
  outerTxSignature: string | null;
  retryable: boolean | null;
  /** The operation this one was filed to replace, if it is a retry. */
  retryOfOperationId: string | null;
}

export interface RingsWorkspace {
  wallet: PrivateWallet;
  balances: AssetBalance[];
  zones: Zone[];
  health: RuntimeHealth;
  recentOperations: PrivateOperationSummary[];
}

export interface PrivateOperationInput {
  walletId: string;
  opType: OpType;
  asset?: { mint: string; amountRaw?: string };
  from?: string;
  to?: string;
  zoneId?: string;
  transferMode?: TransferMode;
  timelock?: { unlockAt: string; beneficiary: string };
  clientNonce: string;
}

export interface OperationFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
}

export interface OperationEvent {
  kind: string;
  createdAt: string;
  payload?: unknown;
}

export interface PrivateOperation {
  id: string;
  walletId: string;
  opType: OpType;
  state: OperationState;
  approvalRequestId: string | null;
  policyEvaluationId: string | null;
  proof: ProofArtifact | null;
  outerTxSignature: string | null;
  photonIndexedAt: string | null;
  failure: OperationFailure | null;
  input: PrivateOperationInput;
  intentKey: string;
  events: OperationEvent[];
  createdAt: string;
  updatedAt: string;
  /** The operation this one was filed to replace, if it is a retry. */
  retryOfOperationId: string | null;
}
