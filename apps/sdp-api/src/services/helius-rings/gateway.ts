import type { RingsGatewayPort, RuntimeHealth } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import {
  createRingsGateway,
  type OuterTransactionPolicyInput,
  validateOuterTransaction as validateSdkOuterTransaction,
} from "@sdp/helius-rings-sdk";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { type ResolvedRingsConnection, resolveRingsConnection } from "./connection-resolver";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsMessage, signRingsOuterTransaction } from "./signer-adapter";

export interface RingsGatewayTenant {
  organizationId: string;
  projectId: string;
}

export interface ResolveRingsGatewayDependencies {
  createGateway?: typeof createRingsGateway;
  signOuterTransaction?: typeof signRingsOuterTransaction;
  signMessage?: typeof signRingsMessage;
  submitOuterTransaction?: typeof submitRingsOuterTransaction;
  /**
   * Persists a ring's lookup table the moment bring-up confirms it, so a crash
   * before the service records the result resumes by adoption instead of
   * renting a second table. The service wires this to the project-ring repo.
   */
  recordRingLookupTable?: (ringProgramId: string, lookupTableAddress: string) => Promise<void>;
}

/**
 * The SDK's policy input, re-exported under the service's name. The SDK type
 * deliberately contains only strings and plain DTOs, so no Kit brand crosses
 * the version boundary and a local mirror would only drift.
 */
export type RingsOuterTransactionPolicyInput = OuterTransactionPolicyInput;

export function validateRingsOuterTransaction(
  input: RingsOuterTransactionPolicyInput
): Promise<void> {
  return validateSdkOuterTransaction(input);
}

export async function resolvePersistedRingsGateway(
  env: Env,
  tenant: RingsGatewayTenant,
  connectionId?: string,
  dependencies: ResolveRingsGatewayDependencies = {}
): Promise<RingsGatewayPort> {
  const connection = await resolveRingsConnection({ env, ...tenant, connectionId });
  return createConfiguredRingsGateway(env, tenant, connection, dependencies);
}

export function createConfiguredRingsGateway(
  env: Env,
  tenant: RingsGatewayTenant,
  connection: ResolvedRingsConnection,
  dependencies: ResolveRingsGatewayDependencies = {}
): RingsGatewayPort {
  const signOuterTransaction = dependencies.signOuterTransaction ?? signRingsOuterTransaction;
  const signMessage = dependencies.signMessage ?? signRingsMessage;
  const submitOuterTransaction = dependencies.submitOuterTransaction ?? submitRingsOuterTransaction;
  const create = dependencies.createGateway ?? createRingsGateway;
  const recordRingLookupTable = dependencies.recordRingLookupTable;

  const gatewayConfig = {
    solanaRpcUrl: connection.solanaRpcUrl,
    indexerUrl: connection.indexerUrl,
    proverUrl: connection.proverUrl,
    ...(connection.ringRpcUrl ? { ringRpcUrl: connection.ringRpcUrl } : {}),
    ...(recordRingLookupTable ? { recordRingLookupTable } : {}),
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    allowInsecureHttp: connection.allowInsecureHttp,
    signTransaction: (unsignedTxBase64: string, owner: string) =>
      asDomainFailure(() =>
        signOuterTransaction({
          env,
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          owner,
          unsignedTxBase64,
        })
      ),
    signMessage: (messageBase64: string, owner: string) =>
      asDomainFailure(() =>
        signMessage({
          env,
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          owner,
          messageBase64,
        })
      ),
    submitTransaction: (signedTxBase64: string) =>
      asDomainFailure(() =>
        submitOuterTransaction({ env, signedTxBase64, rpcUrl: connection.solanaRpcUrl })
      ),
  };
  const gateway = create(gatewayConfig);
  const port = connection.ringRpcUrl
    ? gateway
    : {
        ...gateway,
        provisionRing: () =>
          Promise.reject(
            new HeliusRingsError(
              "config_error",
              "ring bring-up needs a Ring RPC URL in the project's Helius Rings configuration"
            )
          ),
      };
  return instrumentVendorPort("helius-rings", port);
}

const ADAPTER_FAILURE_MESSAGES = {
  signer_failed: "custody could not sign the Rings transaction or attestation for this owner",
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

export class UnconfiguredRingsGateway implements RingsGatewayPort {
  constructor(private readonly reason = "Helius Rings setup is required for this project") {}

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

  async provisionRing(): Promise<never> {
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
