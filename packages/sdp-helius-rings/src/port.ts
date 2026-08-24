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
  /**
   * The indexer position this read must reach before its answer is used, as a
   * uint64 slot string.
   *
   * Photon is a separate service reading the chain, so it always trails it.
   * Without this, a read taken shortly after a transaction lands answers
   * completely and truthfully about a moment before it existed — no error, just
   * the past. Absent for a wallet nothing has touched yet.
   */
  requireSlot?: string;
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
  /**
   * Highest slot this sync saw, as a uint64 string, or absent when the wallet
   * has no history. Advances the wallet's read position so the next sync or
   * spend can gate on it.
   */
  observedSlot?: string;
}

export interface BuildOperationInput {
  operation: PrivateOperation;
  /** base58 Solana address that owns the identity and signs the outer transaction. */
  owner: string;
  /**
   * The identity SDP persisted for this wallet, re-derived and checked before
   * anything is built. A mismatch means this material no longer reproduces the
   * wallet's identity, and building would spend from the wrong one.
   */
  expectedShieldedAddress?: string;
  /**
   * The exact notes a previous build of this operation committed to.
   *
   * Absent on a first build, where the gateway selects them. Present on a
   * rebuild, and then binding: a spend cannot pin its inputs through the SDK's
   * high-level builders, so re-selecting freely after a lost response could
   * choose a disjoint set and land alongside the original, paying the recipient
   * twice. Rebuilding against the same notes cannot — the second attempt is
   * rejected for a spent nullifier.
   */
  pinnedInputs?: string[];
  /** Labels the mints involved; the gateway holds no database handle. */
  knownAssets?: KnownAsset[];
  /** See `SyncPhotonInput.requireSlot`; note selection needs it most. */
  requireSlot?: string;
}

export interface BuildOperationResult {
  outerUnsignedTxBase64: string;
  /** Expected to be exactly the owner; the caller asserts it before signing. */
  requiredSigners: string[];
  /**
   * The blockhash's expiry, as a uint64 string. Persisted with the signed bytes
   * so a recovery can tell "not landed yet" from "can never land".
   */
  lastValidBlockHeight: string;
  /**
   * Note commitments this build spends, to be persisted and passed back as
   * `pinnedInputs` on any rebuild. Empty for a shield, which creates notes
   * rather than consuming them.
   */
  inputNotes: string[];
  proof: ProofArtifact;
}

export interface VerifyIndexedResult {
  indexedAt: string;
  photonRef: string;
  /**
   * The slot Photon indexed it in, as a uint64 string.
   *
   * Recorded on the wallet so the next read can wait for the indexer to reach
   * it. Photon trails the chain, so a read taken immediately after this
   * transaction lands would answer completely and truthfully about a moment
   * before it existed — which is how a spend comes to select a note that has
   * already been consumed.
   */
  slot: string;
}

export interface RingsGatewayPort {
  probeHealth(): Promise<RuntimeHealth>;
  provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult>;
  /** Always a full sync; see `SyncPhotonResult.observedAt` for why there is no cursor. */
  syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult>;
  /**
   * Selects notes, proves, and assembles the unsigned outer transaction.
   *
   * One method rather than the build-then-prove pair this port used to carry.
   * Proving is a real separate call to the prover, but its inputs and its output
   * are zolana-typed objects that cannot cross a Kit-neutral boundary, and the
   * gateway is constructed per request and holds no state between calls. So the
   * proof happens inside, and what crosses is the finished transaction plus the
   * note commitments needed to reproduce it.
   */
  buildOperation(input: BuildOperationInput): Promise<BuildOperationResult>;
  /** Null while Photon has not indexed the signature yet. */
  verifyIndexed(signature: string): Promise<VerifyIndexedResult | null>;
}
