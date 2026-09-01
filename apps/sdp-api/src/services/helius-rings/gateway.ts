import type { RingsGatewayPort, RuntimeHealth } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import {
  createRingsGateway,
  validateOuterTransaction as validateSdkOuterTransaction,
} from "@sdp/helius-rings-sdk";
import { isRingsInsecureHttpAllowed } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

const RINGS_UPSTREAM_ENV_KEYS = {
  solanaRpcUrl: "HELIUS_RINGS_RPC_URL",
  indexerUrl: "HELIUS_RINGS_INDEXER_URL",
  proverUrl: "HELIUS_RINGS_PROVER_URL",
} as const satisfies Record<string, keyof Env>;

type RingsUpstreams = Record<keyof typeof RINGS_UPSTREAM_ENV_KEYS, string>;

export type RingsUpstreamEnv = Pick<
  Env,
  (typeof RINGS_UPSTREAM_ENV_KEYS)[keyof typeof RINGS_UPSTREAM_ENV_KEYS]
>;

export interface RingsGatewayTenant {
  organizationId: string;
  projectId: string;
}

export interface ResolveRingsGatewayDependencies {
  createGateway?: typeof createRingsGateway;
  signOuterTransaction?: typeof signRingsOuterTransaction;
  submitOuterTransaction?: typeof submitRingsOuterTransaction;
}

export type RingsOuterTransactionPolicyInput = Readonly<{
  outerUnsignedTxBase64: string;
  owner: string;
  intent:
    | Readonly<{
        opType: "shield";
        mint: string;
        amountRaw: string;
        expectedShieldedAddress: string;
      }>
    | Readonly<{
        opType: "withdraw";
        mint: string;
        amountRaw: string;
        to: string;
      }>
    | Readonly<{
        opType: "transfer_registered";
        mint: string;
        amountRaw: string;
      }>;
  expectedTree?: string;
}>;

export function validateRingsOuterTransaction(
  input: RingsOuterTransactionPolicyInput
): Promise<void> {
  return validateSdkOuterTransaction(input);
}

export function ringsUpstreamsConfigured(env: RingsUpstreamEnv): boolean {
  return !("missing" in readUpstreams(env));
}

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
    allowInsecureHttp: isRingsInsecureHttpAllowed(env),
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

const ADAPTER_FAILURE_MESSAGES = {
  signer_failed:
    "custody could not sign the Rings registration transaction for this wallet's owner",
  submit_failed:
    "the Rings registration transaction could not be broadcast; confirm the wallet owner holds devnet SOL for the fee",
  // Preflight rejection during provisioning: the SDK's own submit hook. Same
  // shape reason as submit_failed here — the caller has to fix the tx before
  // provisioning can proceed.
  manual_reconciliation_required:
    "the Rings registration transaction was rejected by simulation and never broadcast; verify the wallet owner's balance and reprovision",
} as const satisfies Record<RingsAdapterError["failureCode"], string>;

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

export class UnconfiguredRingsGateway implements RingsGatewayPort {
  private readonly reason: string;

  constructor(missingKeys: readonly string[]) {
    this.reason = `Helius Rings is enabled but ${missingKeys.join(", ")} ${
      missingKeys.length === 1 ? "is" : "are"
    } not configured`;
  }

  async probeHealth(): Promise<RuntimeHealth> {
    return {
      rpc: "red",
      photon: "red",
      prover: "red",
      detail: {
        rpc: this.reason,
        photon: this.reason,
        prover: this.reason,
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

  async verifyIndexed(): Promise<never> {
    return this.fail();
  }

  private fail(): never {
    throw new HeliusRingsError("config_error", this.reason);
  }
}
