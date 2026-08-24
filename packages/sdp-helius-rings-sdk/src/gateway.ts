import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  type BuildOperationInput,
  type BuildOperationResult,
  HeliusRingsError,
  type ProvisionIdentityInput,
  type ProvisionIdentityResult,
  type RingsGatewayPort,
  type RuntimeHealth,
  type SyncPhotonInput,
  type SyncPhotonResult,
  type VerifyIndexedResult,
} from "@sdp/helius-rings";
import { buildRingsOperation } from "./build.js";
import { createRingsClient } from "./client.js";
import { createDeterministicMaterialSource, decodeSeed } from "./deterministic-ka/index.js";
import { probeRingsHealth, withHealthTimeout } from "./health.js";
import { verifyRingsIndexed } from "./indexed.js";
import type { ShieldedMaterialSource } from "./material.js";
import { provisionRingsIdentity } from "./provision.js";
import { syncRingsWallet } from "./sync.js";

/**
 * Everything the gateway needs, as plain strings.
 *
 * This is the Kit-neutral boundary in practice: `@sdp/api` is on `@solana/kit`
 * 6 and this package is on 7, so the factory takes strings and hands back a
 * `RingsGatewayPort` whose every type comes from the Kit-free domain package.
 * No branded address, signature or `bigint` from the SDK crosses over.
 */
export interface RingsGatewayConfig {
  /** Full Helius RPC URL with the API key already applied. */
  readonly solanaRpcUrl: string;
  readonly indexerUrl: string;
  readonly proverUrl: string;
  /**
   * The tenant every wallet this gateway answers for belongs to. Fixed at
   * construction rather than passed per call, so a wallet id cannot be paired
   * with the wrong organization and derive material under someone else's path.
   */
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * Base64 master seed the deterministic key authority derives from. A string
   * rather than a constructed material source, so callers never have to import
   * the Kit-7-typed `./deterministic-ka` entry point to build one.
   *
   * Omitted, the gateway still reports health but refuses anything needing
   * keys, which is what an environment with no seed configured should do.
   */
  readonly derivationSeed?: string;
  /**
   * Signs an outer transaction with SDP custody. Base64 in, base64 out: the
   * owner's Ed25519 secret never leaves custody, so the gateway orchestrates
   * registration but cannot itself sign it.
   *
   * `owner` names the key the transaction requires. One gateway serves every
   * wallet in its tenant, so custody has to be told which of them is signing.
   */
  readonly signTransaction?: (unsignedTxBase64: string, owner: string) => Promise<string>;
  /** Broadcasts a signed outer transaction and returns its signature. */
  readonly submitTransaction?: (signedTxBase64: string) => Promise<string>;
  /** Shielded pool tree; the SDK's default devnet tree when omitted. */
  readonly tree?: string;
  /** Required for the plain-http public devnet indexer and prover. */
  readonly allowInsecureHttp?: boolean;
  readonly healthTimeoutMs?: number;
}

/** Every upstream red, for when the client itself could not be built. */
const ALL_RED: RuntimeHealth = { rpc: "red", photon: "red", prover: "red", gateway: "red" };

/**
 * Why a client could not be built, with the RPC URL and its API key removed.
 *
 * Reporting nothing at all was the safe answer but not a usable one: a rejected
 * tree address and a refused plain-http endpoint both surfaced as "client
 * unavailable" with nothing logged anywhere. The construction error names the
 * cause, and it is only the URL inside it that cannot be published, so the URL
 * and the key are substituted out rather than the whole message discarded.
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
 * The live gateway, running the Rings SDK in this process.
 *
 * Every port method is wired: an identity can be registered, its balances read,
 * and the four default money flows built, signed and confirmed as indexed.
 * Flows this integration does not implement — anonymous transfers, splits,
 * zones, timelocks — are refused at request validation rather than here, so a
 * caller learns they are unsupported before an approval is requested for them.
 *
 * The client is built on first use rather than here, because building it loads
 * the Poseidon hasher and callers construct a gateway per request.
 */
export function createRingsGateway(config: RingsGatewayConfig): RingsGatewayPort {
  let pending: Promise<ZolanaClient> | undefined;

  let materialSource: ShieldedMaterialSource | undefined;

  /**
   * `config_error` rather than `gateway_unavailable`, so a deployment missing
   * its seed or its custody callbacks is not offered a retry that cannot
   * succeed. Health stays reportable without either.
   */
  function requireMaterial(): ShieldedMaterialSource {
    if (!config.derivationSeed) {
      throw new HeliusRingsError(
        "config_error",
        "the Rings gateway has no derivation seed; set HELIUS_RINGS_DETERMINISTIC_KA_SEED"
      );
    }

    if (!materialSource) {
      let seed: Uint8Array;
      try {
        seed = decodeSeed(config.derivationSeed);
      } catch (error) {
        // A seed that is present but unusable is the same operator problem as
        // one that is absent, and must not read as retryable. The reason is
        // carried through because `decodeSeed` describes the shape of the
        // failure — wrong length, bad base64, all zeroes — never the value.
        throw new HeliusRingsError(
          "config_error",
          `the Rings derivation seed is unusable: ${error instanceof Error ? error.message : "unknown reason"}`
        );
      }
      materialSource = createDeterministicMaterialSource({ seed });
    }

    return materialSource;
  }

  function requireCustody<T>(callback: T | undefined, name: string): T {
    if (!callback) {
      throw new HeliusRingsError("config_error", `the Rings gateway was built without ${name}`);
    }
    return callback;
  }

  function client(): Promise<ZolanaClient> {
    if (pending === undefined) {
      // A rejection is not cached: a failure here is as likely to be a
      // transient hasher load as a bad URL, and caching it would make one
      // unlucky request poison every later one.
      pending = createRingsClient(config).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }

    return pending;
  }

  return {
    /**
     * Reports red rather than throwing when the client cannot be built. A
     * health endpoint that 500s on misconfiguration hides the one fact the
     * operator called it for.
     */
    async probeHealth(): Promise<RuntimeHealth> {
      let resolved: ZolanaClient;
      try {
        // Bounded like the upstream probes are. Building the client loads the
        // Poseidon hasher, and an unbounded wait here would hang the one
        // endpoint an operator calls to find out whether things are hanging.
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
      return provisionRingsIdentity(
        {
          client: await client(),
          material: requireMaterial(),
          signTransaction: requireCustody(config.signTransaction, "signTransaction"),
          submitTransaction: requireCustody(config.submitTransaction, "submitTransaction"),
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        { walletId: input.walletId, owner: input.sdpAddress }
      );
    },

    async syncPhoton(input: SyncPhotonInput): Promise<SyncPhotonResult> {
      return syncRingsWallet(
        {
          client: await client(),
          material: requireMaterial(),
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        input
      );
    },

    async buildOperation(input: BuildOperationInput): Promise<BuildOperationResult> {
      return buildRingsOperation(
        {
          client: await client(),
          material: requireMaterial(),
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        input
      );
    },

    async verifyIndexed(signature: string): Promise<VerifyIndexedResult | null> {
      return verifyRingsIndexed(await client(), signature);
    },
  };
}
