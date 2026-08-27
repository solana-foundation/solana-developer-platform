import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  type BuildOperationInput,
  type BuildOperationResult,
  HeliusRingsError,
  type ProofArtifact,
  type ProvisionIdentityInput,
  type ProvisionIdentityResult,
  type ReadIdentityInput,
  type ReadIdentityResult,
  type RequestProofInput,
  type RingsGatewayPort,
  type RuntimeHealth,
  SecretRef,
  type SyncPhotonInput,
  type SyncPhotonResult,
  type VerifyIndexedResult,
} from "@sdp/helius-rings";
import { createRingsClient } from "./client.js";
import {
  createDeterministicMaterialSource,
  DETERMINISTIC_KA_SEED,
  warnDeterministicKeyAuthority,
} from "./deterministic-ka/index.js";
import { withZolanaErrorBridge } from "./error-bridge.js";
import { probeRingsHealth, withHealthTimeout } from "./health.js";
import { readRingsIdentityStatus } from "./identity.js";
import { verifyRingsIndexed } from "./indexed.js";
import type { ShieldedMaterialSource } from "./material.js";
import { provisionRingsIdentity } from "./provision.js";
import { buildShieldTransaction } from "./shield.js";
import { syncRingsWallet } from "./sync.js";

/**
 * Everything the gateway needs, as plain strings. `@sdp/api` is on `@solana/kit`
 * 6 and this package is on 7, so no branded address, signature or SDK `bigint`
 * may cross this boundary.
 */
export interface RingsGatewayConfig {
  /** Full Helius RPC URL with the API key already applied. */
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  /**
   * Fixed at construction rather than passed per call, so a wallet id cannot be
   * paired with the wrong organization and derive material under someone else's
   * path.
   */
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * Signs an outer transaction with SDP custody, base64 in and out; the owner's
   * Ed25519 secret never leaves custody. `owner` names the key the transaction
   * requires, because one gateway serves a whole tenant.
   */
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  /** Broadcasts a signed outer transaction and returns its signature. */
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
  /** Shielded pool tree; the SDK's default devnet tree when omitted. */
  readonly tree?: string;
  /** Required for the plain-http public devnet indexer and prover. */
  readonly allowInsecureHttp?: boolean;
  readonly healthTimeoutMs?: number;
}

/** Every upstream red, for when the client itself could not be built. */
const ALL_RED: RuntimeHealth = { rpc: "red", photon: "red", prover: "red", gateway: "red" };

const MONEY_FLOWS_UNIMPLEMENTED =
  "money flows are not implemented in this build of the Rings gateway";

/**
 * Why a client could not be built. Only the URL and its API key cannot be
 * published, so those are substituted out rather than the message discarded.
 */
function describeClientFailure(error: unknown, config: RingsGatewayConfig): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  const apiKey = readApiKey(config.solanaRpcUrl);
  const secrets = apiKey === null ? [config.solanaRpcUrl] : [config.solanaRpcUrl, apiKey];

  return secrets.reduce(
    (message, secret) => (secret.length === 0 ? message : message.replaceAll(secret, "[redacted]")),
    raw
  );
}

function readApiKey(rpcUrl: string): string | null {
  try {
    return new URL(rpcUrl).searchParams.get("api-key");
  } catch {
    return null;
  }
}

/**
 * The live gateway, running the Rings SDK in this process. Transfer, withdraw
 * and merge are refused rather than stubbed. The client is built on first use
 * because building it loads the Poseidon hasher.
 */
export function createRingsGateway(config: RingsGatewayConfig): RingsGatewayPort {
  let pending: Promise<ZolanaClient> | undefined;
  let materialSource: ShieldedMaterialSource | undefined;

  /** Warns on first derivation, not at construction, so health probes stay quiet. */
  function requireMaterial(): ShieldedMaterialSource {
    if (!materialSource) {
      warnDeterministicKeyAuthority();
      materialSource = createDeterministicMaterialSource({ seed: DETERMINISTIC_KA_SEED });
    }

    return materialSource;
  }

  function client(): Promise<ZolanaClient> {
    if (pending === undefined) {
      // A rejection is not cached: a failure here is as likely to be a transient
      // hasher load as a bad URL, and caching it would poison every later request.
      pending = createRingsClient(config).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }

    return pending;
  }

  function notImplemented(): never {
    throw new HeliusRingsError("gateway_unavailable", MONEY_FLOWS_UNIMPLEMENTED);
  }

  return {
    /**
     * Reports red rather than throwing when the client cannot be built: a health
     * endpoint that 500s on misconfiguration hides the one fact it was called
     * for.
     */
    async probeHealth(): Promise<RuntimeHealth> {
      let resolved: ZolanaClient;
      try {
        // Bounded like the upstream probes: an unbounded wait on the hasher load
        // would hang the endpoint an operator called to find out what is hanging.
        resolved = await withHealthTimeout(client(), config.healthTimeoutMs);
      } catch (error) {
        return {
          ...ALL_RED,
          detail: { gateway: `client unavailable: ${describeClientFailure(error, config)}` },
        };
      }

      return probeRingsHealth({
        client: resolved,
        indexerUrl: config.indexerUrl,
        proverUrl: config.proverUrl,
        timeoutMs: config.healthTimeoutMs,
      });
    },

    async provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult> {
      return withZolanaErrorBridge(async () =>
        provisionRingsIdentity(
          {
            client: await client(),
            material: requireMaterial(),
            signTransaction: config.signTransaction,
            submitTransaction: config.submitTransaction,
            organizationId: config.organizationId,
            projectId: config.projectId,
          },
          { walletId: input.walletId, owner: input.sdpAddress }
        )
      );
    },

    async readIdentity(input: ReadIdentityInput): Promise<ReadIdentityResult> {
      return withZolanaErrorBridge(async () =>
        readRingsIdentityStatus(
          {
            client: await client(),
            material: requireMaterial(),
            organizationId: config.organizationId,
            projectId: config.projectId,
          },
          input
        )
      );
    },

    async syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult> {
      return withZolanaErrorBridge(async () =>
        syncRingsWallet(
          {
            client: await client(),
            material: requireMaterial(),
            organizationId: config.organizationId,
            projectId: config.projectId,
          },
          input
        )
      );
    },

    async buildOperation(input: BuildOperationInput): Promise<BuildOperationResult> {
      if (input.operation.opType !== "shield") {
        return notImplemented();
      }

      return withZolanaErrorBridge(async () => {
        const owner = input.operation.input.from;
        const asset = input.operation.input.asset;
        if (!owner) {
          throw new HeliusRingsError(
            "invalid_input",
            "custody controls no active wallet for this rings wallet's owner"
          );
        }
        if (!asset) {
          throw new HeliusRingsError("invalid_input", "a shield needs an asset and an amount");
        }
        if (!input.expectedShieldedAddress) {
          throw new HeliusRingsError(
            "invalid_input",
            "rings wallet has no shielded identity yet; provision it before shielding"
          );
        }

        const outerUnsignedTxBase64 = await buildShieldTransaction(
          {
            client: await client(),
            material: requireMaterial(),
            organizationId: config.organizationId,
            projectId: config.projectId,
          },
          {
            walletId: input.operation.walletId,
            owner,
            mint: asset.mint,
            amountRaw: asset.amountRaw,
            expectedShieldedAddress: input.expectedShieldedAddress,
          }
        );

        return {
          outerUnsignedTxBase64,
          requiredSigners: [owner],
          ringsMetadata: new SecretRef({ kind: "shield" }),
        };
      });
    },

    async requestProof(input: RequestProofInput): Promise<ProofArtifact> {
      // A shield is a public deposit with no proof, but the pipeline still calls
      // this, so the no-op has to look like one.
      const metadata =
        typeof input.ringsMetadata?.reveal === "function"
          ? input.ringsMetadata.reveal("adapter")
          : undefined;
      if (metadata?.kind !== "shield") {
        return notImplemented();
      }
      return {
        source: "live",
        ref: new SecretRef("shield-deposit"),
        createdAt: new Date().toISOString(),
      };
    },

    async verifyIndexed(txSignature: string): Promise<VerifyIndexedResult | null> {
      return withZolanaErrorBridge(async () => verifyRingsIndexed(await client(), txSignature));
    },
  };
}
