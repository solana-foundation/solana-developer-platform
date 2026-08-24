import type { SecretRef } from "./secrets";
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
 * The only seam between SDP and the Rings upstreams (the Zolana SDK, Photon,
 * the prover and the key authority). Nothing else in the codebase may talk to
 * those upstreams directly.
 *
 * Every type crossing it is a plain DTO: strings, numbers, booleans and arrays
 * of those. That is not a style preference. The live implementation lives in
 * `@sdp/helius-rings-sdk`, which is pinned to `@solana/kit` 7 while the rest of
 * the workspace is on 6, so a branded `Address`, `Signature` or `bigint` from
 * the SDK side would either fail to typecheck here or — worse — structurally
 * match the other major's brand and compile into a silent mismatch. Amounts and
 * slots are therefore decimal strings, and addresses and signatures are base58
 * strings.
 *
 * The tenant is not on any of these inputs. A gateway is built for one
 * organization and project and cannot be asked about another, which is what
 * stops a wallet id from one tenant deriving key material under another's
 * path — a check that would otherwise have to be remembered at every call
 * site. The owner address does cross, because it lives on the wallet row and
 * only SDP can resolve it.
 */

/** The public half of a shielded identity. No secret material crosses the port. */
export interface ShieldedIdentity {
  /** base58 of the compressed shielded address; SDP's canonical identity string. */
  shieldedAddress: string;
  /** base58 Solana address that owns the identity and signs its spends. */
  owner: string;
}

export interface ProvisionIdentityInput {
  walletId: string;
  sdpAddress: string;
}

export interface ProvisionIdentityResult {
  identity: ShieldedIdentity;
  /** Signatures this call landed; empty when the identity was already registered. */
  registrationSignatures: string[];
  /** Whether the on-chain user record permits merging, verified after confirmation. */
  mergingEnabled: boolean;
  /**
   * Whether this identity is backed by real key material. The gateway is the
   * only party that knows, and SDP persists it, so a simulated wallet can never
   * be mistaken for one holding real funds.
   */
  materialTag: MaterialTag;
}

export interface SyncPhotonInput {
  walletId: string;
  /**
   * base58 Solana address that owns the identity. Every gateway call that
   * touches key material needs it, and only SDP can resolve it: the gateway is
   * scoped to a tenant at construction but knows nothing about wallet rows.
   */
  owner: string;
  /**
   * The identity SDP has persisted for this wallet, re-derived and checked
   * before the sync reads anything. Absent only for a wallet that has never
   * been provisioned. A mismatch means the material source's inputs moved, and
   * syncing anyway would report another identity's balances as this wallet's.
   */
  expectedShieldedAddress?: string;
  /**
   * The mints this project recognises, used to label balances. Passed in rather
   * than looked up, because the allowlist is SDP state and the gateway holds no
   * database handle. Balances for anything absent here are still returned —
   * hiding a holding would be worse than labelling it unknown.
   */
  knownAssets?: KnownAsset[];
}

export interface KnownAsset {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface SyncPhotonResult {
  balances: AssetBalance[];
  history: PrivateHistoryEntry[];
  report: SyncReport;
  /** Outer transaction signatures Photon has indexed for this wallet. */
  indexedOperationSignatures: string[];
  /**
   * When this sync observed the chain. Diagnostics for the dashboard only — it
   * is never fed back in as a resume position, which is why there is no input
   * cursor. The SDK keeps three independent read streams (transactions,
   * proofless and nullifiers) and documents that reaching the tip of one says
   * nothing about the others, so a single resumable cursor would skip rows in
   * whichever stream was behind.
   */
  observedAt: string;
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  /** base58 Solana address that owns the identity and signs the outer transaction. */
  owner: string;
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
  /** Always a full sync; see `SyncPhotonResult.observedAt` for why there is no cursor. */
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  /**
   * Attests the proof that `buildOperation` already produced.
   *
   * The TypeScript builder proves and assembles in one call, so there is no
   * separate proving step left to trigger. This stays on the port as a
   * compatibility shim for the existing operation pipeline and its `proof_ref`
   * column, and should be folded into `buildOperation` when that pipeline is
   * next revisited.
   */
  requestProof(input: RequestProofInput): Promise<ProofArtifact>;
  /** Null while Photon has not indexed the signature yet. */
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
