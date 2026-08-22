import type {
  BuildOperationInput,
  BuildOperationResult,
  ProvisionIdentityInput,
  ProvisionIdentityResult,
  RequestProofInput,
  RingsGatewayPort,
  SyncPhotonInput,
  SyncPhotonResult,
  VerifyIndexedResult,
} from "../port";
import { SecretRef } from "../secrets";
import type { ProofArtifact, RuntimeHealth } from "../types";

/**
 * Test-only implementation of RingsGatewayPort. Never shipped: it lives under
 * src/testing/, is exported only via the `@sdp/helius-rings/testing` subpath,
 * and is not selectable by environment. Production uses
 * NotImplementedRingsGateway until Track B lands the live adapter.
 *
 * Deterministic by construction — outputs derive from a hash of the inputs,
 * and time comes from the injected clock — so the same test always sees the
 * same values.
 */

export interface InMemoryRingsGatewayOptions {
  /** Injected clock; defaults to the real one. */
  now?: () => string;
  /** Health returned by probeHealth; defaults to all green. */
  health?: RuntimeHealth;
  /** How long after submission verifyIndexed starts reporting indexed. */
  indexingDelayMs?: number;
  /** Override for tests that need a signable unsigned tx (A8/A9). */
  buildUnsignedTx?: (input: BuildOperationInput) => string;
}

const ALL_GREEN: RuntimeHealth = {
  rpc: "green",
  prover: "green",
  photon: "green",
  gateway: "green",
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// biome-ignore lint/security/noSecrets: character alphabet, not a secret.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64 so the package needs neither Buffer nor btoa types. */
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64_ALPHABET[c & 63];
  }
  return out;
}

export class InMemoryRingsGateway implements RingsGatewayPort {
  private readonly now: () => string;
  private readonly health: RuntimeHealth;
  private readonly indexingDelayMs: number;
  private readonly buildUnsignedTx?: (input: BuildOperationInput) => string;
  private readonly syncCounters = new Map<string, number>();
  private readonly submittedAt = new Map<string, number>();

  constructor(options: InMemoryRingsGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.health = options.health ?? ALL_GREEN;
    this.indexingDelayMs = options.indexingDelayMs ?? 0;
    this.buildUnsignedTx = options.buildUnsignedTx;
  }

  async probeHealth(): Promise<RuntimeHealth> {
    return { ...this.health };
  }

  async provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult> {
    const seed = `${input.walletId}:${input.sdpAddress}`;
    return {
      shieldedAddress: `rings1${hashHex(`${seed}:address`, 16)}`,
      keyRefs: (["viewing", "nullifier"] as const).map((kind) => ({
        kind,
        material: new SecretRef(hexToBytes(hashHex(`${seed}:${kind}`, 32))),
        materialTag: "simulated",
        keyVersion: "v1",
      })),
    };
  }

  async syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult> {
    const next = (this.syncCounters.get(input.walletId) ?? 0) + 1;
    this.syncCounters.set(input.walletId, next);
    return {
      cursor: `slot:${next}`,
      balances: [
        {
          // biome-ignore lint/security/noSecrets: wrapped SOL mint address, not a secret.
          mint: "So11111111111111111111111111111111111111112",
          amountRaw: String(1_000_000_000 * next),
          decimals: 9,
          symbol: "SOL",
        },
      ],
      indexedOperationSignatures: [],
    };
  }

  async buildOperation(input: BuildOperationInput): Promise<BuildOperationResult> {
    const seed = `${input.operation.walletId}:${input.operation.opType}:${input.operation.intentKey}`;
    const outerUnsignedTxBase64 =
      this.buildUnsignedTx?.(input) ?? bytesToBase64(hexToBytes(hashHex(`${seed}:tx`, 64)));
    return {
      outerUnsignedTxBase64,
      requiredSigners: [input.operation.walletId],
      ringsMetadata: new SecretRef({ seed: hashHex(`${seed}:metadata`, 16) }),
    };
  }

  async requestProof(input: RequestProofInput): Promise<ProofArtifact> {
    return {
      source: "simulated",
      ref: new SecretRef(hashHex(`${input.operationId}:proof`, 32)),
      createdAt: this.now(),
    };
  }

  /** Tests call this to start the indexing clock for a signature. */
  recordSubmission(signature: string): void {
    this.submittedAt.set(signature, Date.parse(this.now()));
  }

  async verifyIndexed(signature: string): Promise<VerifyIndexedResult | null> {
    const submitted = this.submittedAt.get(signature);
    if (submitted === undefined) return null;
    const elapsed = Date.parse(this.now()) - submitted;
    if (elapsed < this.indexingDelayMs) return null;
    return {
      indexedAt: this.now(),
      photonRef: `photon:${hashHex(signature, 8)}`,
    };
  }
}
