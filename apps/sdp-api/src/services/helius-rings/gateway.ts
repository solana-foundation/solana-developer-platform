import type { RingsGatewayPort, RuntimeHealth } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import { createRingsGateway } from "@sdp/helius-rings-sdk";
import { isRingsInsecureHttpAllowed } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

/**
 * Builds the gateway a tenant talks to, and is the only file in `apps/`
 * allowed to import `@sdp/helius-rings-sdk`.
 *
 * That restriction is not stylistic. The SDK package is pinned to `@solana/kit`
 * 7 and this app is on 6, and two majors' branded types can match structurally
 * — so a leaked `Address` or `Signature` typechecks here and then misbehaves at
 * runtime. Only plain strings and `@sdp/helius-rings` types cross this seam.
 */

/**
 * SDK config field ← environment key, so the missing-variable list an operator
 * reads and the config that consumes those values cannot drift apart.
 */
const RINGS_UPSTREAM_ENV_KEYS = {
  solanaRpcUrl: "HELIUS_RINGS_RPC_URL",
  indexerUrl: "HELIUS_RINGS_INDEXER_URL",
  proverUrl: "HELIUS_RINGS_PROVER_URL",
  derivationSeed: "HELIUS_RINGS_DETERMINISTIC_KA_SEED",
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
 * True when every upstream the SDK needs is set. The indexing poll asks the
 * same question, and asking it there keeps a half-configured deployment from
 * logging a warning per in-flight operation every minute.
 */
export function ringsUpstreamsConfigured(env: RingsUpstreamEnv): boolean {
  return !("missing" in readUpstreams(env));
}

/**
 * Builds the gateway for one tenant.
 *
 * The tenant is fixed here rather than passed per call because the SDK derives
 * shielded key material from it: a gateway that took the organization as an
 * argument could be handed a wallet id belonging to a different one and derive
 * material under someone else's path.
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
    // The owner's Ed25519 secret stays in custody, so the SDK orchestrates the
    // registration it cannot itself sign. `owner` names the key the transaction
    // requires, because one gateway serves a whole tenant.
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
 * What the operator is told when SDP's own signer or RPC is the thing that
 * failed.
 *
 * Fixed text rather than the upstream message. An RPC error routinely quotes
 * the endpoint it failed on, and this deployment's endpoint carries a Helius
 * API key, so forwarding it would put that key in an API response. Each string
 * instead names the stage and the one thing an operator can act on.
 */
const ADAPTER_FAILURE_MESSAGES = {
  signer_failed:
    "custody could not sign the Rings registration transaction for this wallet's owner",
  submit_failed:
    "the Rings registration transaction could not be broadcast; confirm the wallet owner holds devnet SOL for the fee",
} as const satisfies Record<RingsAdapterError["failureCode"], string>;

/**
 * Translates an adapter failure at the one boundary where SDP's signer and RPC
 * cross into the SDK.
 *
 * Without this the `RingsAdapterError` an unfunded owner produces travels back
 * through the SDK untouched, past an error bridge that only recognises Zolana's
 * own error classes, and reaches the route as an unmapped exception — so the
 * operator gets an opaque 500 for a condition they could fix in a minute.
 *
 * Only provisioning goes through these callbacks. The operation pipeline calls
 * the same adapters directly and still catches `RingsAdapterError` itself,
 * because it needs the failure code to take the state machine's fail edge.
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
 * empty string counts as absent: a `KEY=` line in a .env is an operator who
 * has not filled it in, not an operator who chose the empty URL.
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
 * The gateway for a deployment with something still unset.
 *
 * It does not throw at construction: that would 500 every Rings request
 * including the health probe an operator reaches for first — and the service is
 * constructed outside `withRingsErrors` in every handler, so a domain error
 * raised there escapes unmapped. So health answers, red, naming the variables;
 * everything else fails closed.
 */
export class UnconfiguredRingsGateway implements RingsGatewayPort {
  private readonly reason: string;

  constructor(missingKeys: readonly string[]) {
    this.reason = `Helius Rings is enabled but ${missingKeys.join(", ")} ${
      missingKeys.length === 1 ? "is" : "are"
    } not configured`;
  }

  /**
   * Every component red, each carrying the same reason. None of them is red
   * because that upstream was found unhealthy — nothing was probed — so naming
   * the missing variables on all four is the honest answer, and it is the one
   * the operator sees whichever component they look at.
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
   * `config_error`, never `gateway_unavailable`: the fix is an environment
   * edit, so offering a retry would point the operator at a button that cannot
   * succeed.
   */
  private fail(): never {
    throw new HeliusRingsError("config_error", this.reason);
  }
}
