import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type {
  BuildOperationInput,
  BuildOperationResult,
  ProvisionIdentityInput,
  ProvisionIdentityResult,
  ReadIdentityInput,
  ReadIdentityResult,
  RingsGatewayPort,
  RuntimeHealth,
  SyncPhotonInput,
  SyncPhotonResult,
  VerifyIndexedResult,
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
import { syncRingsWallet } from "./sync.js";

export interface RingsGatewayConfig {
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
  readonly tree?: string;
  readonly allowInsecureHttp?: boolean;
  readonly healthTimeoutMs?: number;
}

const ALL_RED: RuntimeHealth = { rpc: "red", photon: "red", prover: "red" };

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
