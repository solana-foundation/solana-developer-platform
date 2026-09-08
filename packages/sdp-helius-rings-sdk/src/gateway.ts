import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  type BuildOperationInput,
  type BuildOperationResult,
  HeliusRingsError,
  type ProvisionIdentityInput,
  type ProvisionIdentityResult,
  type ProvisionRingInput,
  type ProvisionRingResult,
  type ReadIdentityInput,
  type ReadIdentityResult,
  type RingsGatewayPort,
  type RuntimeHealth,
  type SyncPhotonInput,
  type SyncPhotonResult,
  type VerifyIndexedResult,
} from "@sdp/helius-rings";
import { buildRingsOperation } from "./build.js";
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
import { provisionCustomRing } from "./provision-ring.js";
import { syncRingsWallet } from "./sync.js";

export interface RingsGatewayConfig {
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
  /**
   * Signs a raw message with the custody key for `owner`. Only ring bring-up
   * needs it — the auditor-key attestation is a signed message, not a
   * transaction — so the rest of the gateway stays constructible without it.
   */
  readonly signMessage?: (messageBase64: string, owner: string) => Promise<string>;
  /** Helius ring RPC that mints custom-ring auditor keys. Only bring-up needs it. */
  readonly ringRpcUrl?: string;
  /**
   * Persists a ring's lookup table the moment it confirms, mid-bring-up. Only
   * bring-up needs it; without it a crash between the table landing and the
   * caller persisting the result rents a second table on resume.
   */
  readonly recordRingLookupTable?: (
    ringProgramId: string,
    lookupTableAddress: string
  ) => Promise<void>;
  readonly tree?: string;
  readonly allowInsecureHttp?: boolean;
  readonly healthTimeoutMs?: number;
}

const ALL_RED: RuntimeHealth = { rpc: "red", photon: "red", prover: "red" };

function describeClientFailure(error: unknown, config: RingsGatewayConfig): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  const secrets = [config.solanaRpcUrl, config.indexerUrl, config.proverUrl].flatMap((url) => [
    url,
    ...readQueryValues(url),
  ]);

  return secrets.reduce(
    (message, secret) => (secret.length === 0 ? message : message.replaceAll(secret, "[redacted]")),
    raw
  );
}

function readQueryValues(endpointUrl: string): string[] {
  try {
    return [...new URL(endpointUrl).searchParams.values()].filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

/**
 * What bring-up needs beyond the base config, checked as configuration rather
 * than left to fail inside the flow. Fixed messages: a URL echo could carry an
 * API key, and the insecure-http rule matches the indexer and prover.
 */
function requireRingBringUpConfig(config: RingsGatewayConfig): {
  ringRpcUrl: string;
  signMessage: NonNullable<RingsGatewayConfig["signMessage"]>;
} {
  const { ringRpcUrl, signMessage } = config;
  if (!ringRpcUrl) {
    throw new HeliusRingsError("config_error", "ring bring-up needs a ring RPC URL");
  }
  if (!signMessage) {
    throw new HeliusRingsError("config_error", "ring bring-up needs a custody message signer");
  }

  let protocol: string;
  try {
    protocol = new URL(ringRpcUrl).protocol;
  } catch {
    throw new HeliusRingsError("config_error", "the configured ring RPC URL is not a valid URL");
  }
  if (!config.allowInsecureHttp && protocol !== "https:") {
    throw new HeliusRingsError(
      "config_error",
      "the configured ring RPC URL is not https and insecure http is not allowed"
    );
  }

  return { ringRpcUrl, signMessage };
}

export function createRingsGateway(config: RingsGatewayConfig): RingsGatewayPort {
  let pending: Promise<ZolanaClient> | undefined;
  let materialSource: ShieldedMaterialSource | undefined;

  function requireMaterial(): ShieldedMaterialSource {
    if (!materialSource) {
      warnDeterministicKeyAuthority();
      materialSource = createDeterministicMaterialSource({ seed: DETERMINISTIC_KA_SEED });
    }
    return materialSource;
  }

  function client(): Promise<ZolanaClient> {
    if (pending === undefined) {
      pending = createRingsClient(config).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  }

  return {
    async probeHealth(): Promise<RuntimeHealth> {
      let resolved: ZolanaClient;
      try {
        resolved = await withHealthTimeout(client(), config.healthTimeoutMs);
      } catch (error) {
        // The Zolana client couldn't even initialize — none of the per-upstream
        // probes ran. Repeat the reason on each so the operator sees it whichever
        // tile they look at.
        const reason = `client unavailable: ${describeClientFailure(error, config)}`;
        return {
          ...ALL_RED,
          detail: { rpc: reason, photon: reason, prover: reason },
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

    async provisionRing(input: ProvisionRingInput): Promise<ProvisionRingResult> {
      const bringUp = requireRingBringUpConfig(config);
      const recordRingLookupTable = config.recordRingLookupTable;
      return withZolanaErrorBridge(async () =>
        provisionCustomRing(
          {
            client: await client(),
            ringRpcUrl: bringUp.ringRpcUrl,
            signTransaction: config.signTransaction,
            signMessage: bringUp.signMessage,
            submitTransaction: config.submitTransaction,
            ...(recordRingLookupTable
              ? {
                  recordLookupTable: (lookupTableAddress: string) =>
                    recordRingLookupTable(input.ringProgramId, lookupTableAddress),
                }
              : {}),
          },
          input
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
      return withZolanaErrorBridge(async () =>
        buildRingsOperation(
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

    async verifyIndexed(signature: string): Promise<VerifyIndexedResult | null> {
      return withZolanaErrorBridge(async () => verifyRingsIndexed(await client(), signature));
    },
  };
}
