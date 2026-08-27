import type { RingsGatewayPort, RuntimeHealth } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import { createRingsGateway } from "@sdp/helius-rings-sdk";
import { isRingsInsecureHttpAllowed } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

/**
 * The only file in `apps/` allowed to import `@sdp/helius-rings-sdk`: the SDK is
 * pinned to `@solana/kit` 7 and this app to 6, and two majors' branded types can
 * match structurally, so only plain strings cross this seam.
 */

/** SDK config field ← environment key, so the two cannot drift apart. */
const RINGS_UPSTREAM_ENV_KEYS = {
  solanaRpcUrl: "HELIUS_RINGS_RPC_URL",
  indexerUrl: "HELIUS_RINGS_INDEXER_URL",
  proverUrl: "HELIUS_RINGS_PROVER_URL",
} as const satisfies Record<string, keyof Env>;

type RingsUpstreams = Record<keyof typeof RINGS_UPSTREAM_ENV_KEYS, string>;

/** Just the variables the gateway reads, so callers need not hold a whole `Env`. */
export type RingsUpstreamEnv = Pick<
  Env,
  (typeof RINGS_UPSTREAM_ENV_KEYS)[keyof typeof RINGS_UPSTREAM_ENV_KEYS]
>;

export interface RingsGatewayTenant {
  organizationId: string;
  projectId: string;
}

export interface ResolveRingsGatewayDependencies {
  /** Test seam; production builds the SDK gateway. */
  createGateway?: typeof createRingsGateway;
  signOuterTransaction?: typeof signRingsOuterTransaction;
  submitOuterTransaction?: typeof submitRingsOuterTransaction;
}

/**
 * True when every upstream the SDK needs is set. The indexing poll asks the same
 * question so a half-configured deployment does not warn once per operation.
 */
export function ringsUpstreamsConfigured(env: RingsUpstreamEnv): boolean {
  return !("missing" in readUpstreams(env));
}

/**
 * Builds the gateway for one tenant. The tenant is fixed at construction because
 * the SDK derives shielded key material from it, and a per-call tenant could
 * derive under another organization's path.
 */
export function resolveRingsGateway(
  env: Env,
  tenant: RingsGatewayTenant,
  dependencies: ResolveRingsGatewayDependencies = {}
): RingsGatewayPort {
  const configured = readUpstreams(env);
  if ("missing" in configured) {
    return new UnconfiguredRingsGateway(configured.missing);
  }

  const signOuterTransaction = dependencies.signOuterTransaction ?? signRingsOuterTransaction;
  const submitOuterTransaction = dependencies.submitOuterTransaction ?? submitRingsOuterTransaction;
  const create = dependencies.createGateway ?? createRingsGateway;

  return create({
    ...configured.upstreams,
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    // Off unless an operator says otherwise, so a production typo cannot
    // quietly authorise plaintext.
    allowInsecureHttp: isRingsInsecureHttpAllowed(env),
    // The owner's Ed25519 secret stays in custody, so the SDK cannot sign the
    // registration itself; `owner` names the key the transaction requires.
    signTransaction: (unsignedTxBase64, owner) =>
      asDomainFailure(() =>
        signOuterTransaction({
          env,
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          owner,
          unsignedTxBase64,
        })
      ),
    submitTransaction: (signedTxBase64) =>
      asDomainFailure(() => submitOuterTransaction({ env, signedTxBase64 })),
  });
}

/**
 * What the operator is told when SDP's own signer or RPC failed. Fixed text
 * rather than the upstream message: an RPC error quotes the endpoint it failed
 * on, and this deployment's endpoint carries a Helius API key.
 */
const ADAPTER_FAILURE_MESSAGES = {
  signer_failed:
    "custody could not sign the Rings registration transaction for this wallet's owner",
  submit_failed:
    "the Rings registration transaction could not be broadcast; confirm the wallet owner holds devnet SOL for the fee",
} as const satisfies Record<RingsAdapterError["failureCode"], string>;

/**
 * Translates an adapter failure at the one boundary where SDP's signer and RPC
 * cross into the SDK: its error bridge only recognises Zolana's own classes, so
 * an untranslated `RingsAdapterError` reaches the route as an opaque 500.
 */
async function asDomainFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof RingsAdapterError)) throw error;
    throw new HeliusRingsError(
      error.retryable ? "gateway_unavailable" : "invalid_input",
      ADAPTER_FAILURE_MESSAGES[error.failureCode]
    );
  }
}

/**
 * Either every upstream value, or the names of the ones that are absent. An
 * empty string counts as absent: a `KEY=` line is an unfilled variable.
 */
function readUpstreams(
  env: RingsUpstreamEnv
): { upstreams: RingsUpstreams } | { missing: string[] } {
  const upstreams = {} as RingsUpstreams;
  const missing: string[] = [];

  for (const [field, key] of Object.entries(RINGS_UPSTREAM_ENV_KEYS) as Array<
    [keyof RingsUpstreams, keyof RingsUpstreamEnv]
  >) {
    const value = (env[key] ?? "").trim();
    if (value === "") {
      missing.push(key);
      continue;
    }
    upstreams[field] = value;
  }

  return missing.length > 0 ? { missing } : { upstreams };
}

/**
 * The gateway for a deployment with something still unset. It does not throw at
 * construction — the service is built outside `withRingsErrors`, so that would
 * 500 even the health probe — so health answers red and the rest fails closed.
 */
export class UnconfiguredRingsGateway implements RingsGatewayPort {
  private readonly reason: string;

  constructor(missingKeys: readonly string[]) {
    this.reason = `Helius Rings is enabled but ${missingKeys.join(", ")} ${
      missingKeys.length === 1 ? "is" : "are"
    } not configured`;
  }

  /**
   * Every component red with the same reason: nothing was probed, so naming the
   * missing variables on all four is what the operator needs whichever they read.
   */
  async probeHealth(): Promise<RuntimeHealth> {
    return {
      rpc: "red",
      photon: "red",
      prover: "red",
      gateway: "red",
      detail: {
        rpc: this.reason,
        photon: this.reason,
        prover: this.reason,
        gateway: this.reason,
      },
    };
  }

  async provisionIdentity(): Promise<never> {
    return this.fail();
  }

  async readIdentity(): Promise<never> {
    return this.fail();
  }

  async syncPhoton(): Promise<never> {
    return this.fail();
  }

  async buildOperation(): Promise<never> {
    return this.fail();
  }

  async requestProof(): Promise<never> {
    return this.fail();
  }

  async verifyIndexed(): Promise<never> {
    return this.fail();
  }

  /**
   * `config_error`, never `gateway_unavailable`: the fix is an environment edit,
   * so a retry cannot succeed and must not be offered.
   */
  private fail(): never {
    throw new HeliusRingsError("config_error", this.reason);
  }
}
