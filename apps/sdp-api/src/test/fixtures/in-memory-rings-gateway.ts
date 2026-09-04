import type {
  BuildOperationInput,
  BuildOperationResult,
  ProvisionIdentityInput,
  ProvisionIdentityResult,
  ProvisionRingInput,
  ProvisionRingResult,
  ReadIdentityInput,
  ReadIdentityResult,
  RingsGatewayPort,
  RuntimeHealth,
  SyncPhotonInput,
  SyncPhotonResult,
  VerifyIndexedResult,
} from "@sdp/helius-rings";
import { SecretRef } from "@sdp/helius-rings";

/** Wrapped SOL, the mint SDP uses to mean native lamports. */
const NATIVE_MINT = "So11111111111111111111111111111111111111112";

/**
 * Test-only implementation of RingsGatewayPort, deterministic by construction:
 * outputs derive from a hash of the inputs and time comes from the injected
 * clock, so the same test always sees the same values.
 */

export interface InMemoryRingsGatewayOptions {
  /** Injected clock; defaults to the real one. */
  now?: () => string;
  /** Health returned by probeHealth; defaults to all green. */
  health?: RuntimeHealth;
  /** How long after submission verifyIndexed starts reporting indexed. */
  indexingDelayMs?: number;
  /** Override for tests that need a signable unsigned tx. */
  buildUnsignedTx?: (input: BuildOperationInput) => string;
  /** Reported as the signed bytes' expiry, for the expiry sweep. */
  blockHeight?: number;
  /** Override for tests that need ring bring-up to fail. */
  provisionRing?: (input: ProvisionRingInput) => Promise<ProvisionRingResult>;
}

/** Op types that consume notes, and so have inputs worth pinning. */
const SPENDS = new Set<string>(["transfer_registered", "withdraw", "merge"]);

const ALL_GREEN: RuntimeHealth = {
  rpc: "green",
  prover: "green",
  photon: "green",
};

/** FNV-1a, hex-encoded — deterministic bytes without a crypto dependency. */
function hashHex(seed: string, bytes: number): string {
  let hash = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < bytes * 2; round++) {
    const input = `${seed}:${round}`;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, bytes * 2);
}

export class InMemoryRingsGateway implements RingsGatewayPort {
  private readonly now: () => string;
  private readonly health: RuntimeHealth;
  private readonly indexingDelayMs: number;
  private readonly buildUnsignedTx?: (input: BuildOperationInput) => string;
  private readonly blockHeight: number;
  private readonly provisionRingOverride?: (
    input: ProvisionRingInput
  ) => Promise<ProvisionRingResult>;
  private readonly syncCounters = new Map<string, number>();
  private readonly submittedAt = new Map<string, number>();

  constructor(options: InMemoryRingsGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.health = options.health ?? ALL_GREEN;
    this.indexingDelayMs = options.indexingDelayMs ?? 0;
    this.buildUnsignedTx = options.buildUnsignedTx;
    this.blockHeight = options.blockHeight ?? 1_000;
    this.provisionRingOverride = options.provisionRing;
  }

  async probeHealth(): Promise<RuntimeHealth> {
    return { ...this.health };
  }

  async provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult> {
    const seed = `${input.walletId}:${input.sdpAddress}`;
    return {
      identity: {
        shieldedAddress: `rings1${hashHex(`${seed}:address`, 16)}`,
        owner: input.sdpAddress,
      },
      registrationSignatures: [`sig:${hashHex(`${seed}:register`, 8)}`],
      mergingEnabled: true,
      materialTag: "simulated",
    };
  }

  async provisionRing(input: ProvisionRingInput): Promise<ProvisionRingResult> {
    if (this.provisionRingOverride) {
      return this.provisionRingOverride(input);
    }
    return {
      // 65-byte uncompressed SEC1 shape: 0x04 then two deterministic 32-byte halves.
      auditorPublicKeyHex: `04${hashHex(`auditor:${input.ringProgramId}`, 64)}`,
      // Adopts a recorded table like real bring-up; otherwise a deterministic
      // base58-shaped address (hex with 0, the one invalid char, swapped out).
      lookupTableAddress:
        input.lookupTableAddress ??
        `Lt${hashHex(`lookup:${input.ringProgramId}`, 20).replaceAll("0", "z")}`,
    };
  }

  async readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult> {
    const shieldedAddress = `rings1${hashHex(`${input.walletId}:${input.owner}:address`, 16)}`;
    return {
      status: "ours",
      derivedShieldedAddress: shieldedAddress,
      publishedShieldedAddress: shieldedAddress,
      mismatch: null,
    };
  }

  /**
   * Each call reports one more shielded SOL note than the last, so a test can
   * tell a second sync from a repeat of the first without reaching inside.
   */
  async syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult> {
    const next = (this.syncCounters.get(input.walletId) ?? 0) + 1;
    this.syncCounters.set(input.walletId, next);
    const amountRaw = String(1_000_000_000 * next);

    return {
      balances: [{ mint: NATIVE_MINT, amountRaw, decimals: 9, symbol: "SOL", ringProgramId: null }],
      history: [
        {
          signature: `sig:${hashHex(`${input.walletId}:${next}`, 8)}`,
          slot: String(next),
          index: "0",
          kind: "shield",
          direction: "inbound",
          mint: NATIVE_MINT,
          amountRaw,
        },
      ],
      report: {
        storedNotes: next,
        unparsedTransactions: 0,
        undecryptableCandidates: 0,
        unknownAssetIds: 0,
        unknownAssetFields: 0,
        degraded: false,
      },
      indexedOperationSignatures: [],
      observedAt: this.now(),
      // The furthest slot this fake history reaches, so a caller that gates its
      // next read on the position advances instead of asking for nothing.
      observedSlot: String(next),
    };
  }

  async buildOperation(input: BuildOperationInput): Promise<BuildOperationResult> {
    const seed = `${input.operation.walletId}:${input.operation.opType}:${input.operation.intentKey}`;
    return {
      outerUnsignedTxBase64:
        this.buildUnsignedTx?.(input) ??
        Buffer.from(hashHex(`${seed}:tx`, 64), "hex").toString("base64"),
      // The owner signs the outer transaction. A wallet id here would type-check
      // and read as an address to everything downstream, which is exactly the
      // confusion a test double should not introduce.
      requiredSigners: [input.owner],
      lastValidBlockHeight: String(this.blockHeight),
      // Honours pinned inputs, so a test can assert that a rebuild spends what
      // the first build committed to rather than choosing again. Ring-bound
      // spends mirror the real SDK: the one-call builders re-select notes on
      // every build, so nothing is pinned and nothing comes back.
      inputNotes:
        SPENDS.has(input.operation.opType) && !input.operation.ringProgramId
          ? (input.pinnedInputs ?? [`note:${hashHex(`${seed}:note`, 16)}`])
          : [],
      proof: {
        source: "simulated",
        ref: new SecretRef(hashHex(`${seed}:proof`, 32)),
        createdAt: this.now(),
      },
    };
  }

  /** Tests call this to start the indexing clock for a signature. */
  recordSubmission(signature: string): void {
    this.submittedAt.set(signature, Date.parse(this.now()));
  }

  async verifyIndexed(signature: string): Promise<VerifyIndexedResult | null> {
    const submitted = this.submittedAt.get(signature);
    if (submitted === undefined) return null;
    if (Date.parse(this.now()) - submitted < this.indexingDelayMs) return null;
    return {
      indexedAt: this.now(),
      photonRef: `photon:${hashHex(signature, 8)}`,
      // Past the configured expiry, so a wallet gating its next read on this
      // slot does not wait for a position the double will never report.
      slot: String(this.blockHeight),
    };
  }
}
