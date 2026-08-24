import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  type BuildOperationResult,
  HeliusRingsError,
  type ProofArtifact,
  type ProvisionIdentityResult,
  type RingsGatewayPort,
  type RuntimeHealth,
  type SyncPhotonResult,
  type VerifyIndexedResult,
} from "@sdp/helius-rings";
import { createRingsClient } from "./client.js";
import { probeRingsHealth } from "./health.js";

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

function notWired(method: string): never {
  throw new HeliusRingsError(
    "gateway_unavailable",
    `${method} is not implemented by the Rings TypeScript gateway yet`
  );
}

/**
 * The live gateway, running the Rings SDK in this process.
 *
 * Only `probeHealth` is wired: it is what makes the adapter selectable and
 * observable before any money flow exists. The rest fail closed with the same
 * `gateway_unavailable` code the not-implemented gateway uses, so an operation
 * that reaches them lands in `failed:gateway_unavailable` rather than appearing
 * to have succeeded.
 *
 * The client is built on first use rather than here, because building it loads
 * the Poseidon hasher and callers construct a gateway per request.
 */
export function createRingsGateway(config: RingsGatewayConfig): RingsGatewayPort {
  let pending: Promise<ZolanaClient> | undefined;

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
        resolved = await client();
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

    // `async` so an unwired method rejects rather than throwing synchronously;
    // a port declared to return a promise must fail the way callers catch.
    async provisionIdentity(): Promise<ProvisionIdentityResult> {
      return notWired("provisionIdentity");
    },

    async syncPhoton(): Promise<SyncPhotonResult> {
      return notWired("syncPhoton");
    },

    async buildOperation(): Promise<BuildOperationResult> {
      return notWired("buildOperation");
    },

    async requestProof(): Promise<ProofArtifact> {
      return notWired("requestProof");
    },

    async verifyIndexed(): Promise<VerifyIndexedResult | null> {
      return notWired("verifyIndexed");
    },
  };
}
