import {
  createFeePaymentAdapter,
  FeePaymentError,
  type FeePaymentPort,
  resolveFeePaymentProvider,
  type SponsorshipProviderConfiguration,
} from "@sdp/payments/fee-payment";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { ProjectEnvironment } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";
import { BudgetedFeePayment, getFullySignedSubmission } from "./sponsorship-budget.service";
import { assertSponsorSignedSameMessage } from "./sponsorship-integrity";

export type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

/**
 * Who a sponsored transaction is charged to. The cluster is not part of it: the fee payer, the
 * budget network and the fee-pricing RPC all follow the open cluster scope.
 */
export interface SponsorshipScope {
  environment: ProjectEnvironment;
  organizationId: string;
  projectId: string | null;
  actor: {
    type: SponsorshipActorType;
    id: string;
  };
}

export interface OwnedSignedSubmission {
  signedTransaction: Uint8Array;
  signature: Signature;
}

export interface PreparedOwnedSubmission extends OwnedSignedSubmission {
  releaseDefinitelyUnbroadcast(error: unknown): Promise<void>;
}

export interface OwnedSubmissionLifecycle {
  persistSigned(submission: OwnedSignedSubmission): Promise<void>;
  markStarted(): Promise<void>;
  hasStarted(): Promise<boolean>;
}

/** App-local extension for SDP-owned submission flows. */
export interface SponsorshipFeePayment extends FeePaymentPort {
  prepareOwnedSubmission(
    transaction: Uint8Array,
    lifecycle: OwnedSubmissionLifecycle
  ): Promise<PreparedOwnedSubmission>;
}

function withOwnedSubmissionLifecycle(provider: FeePaymentPort): SponsorshipFeePayment {
  const getSponsorshipConfiguration = provider.getSponsorshipConfiguration;
  let feePayer: Promise<Address> | undefined;
  const sponsor = () => {
    if (!feePayer) {
      feePayer = provider.getFeePayer();
      feePayer.catch(() => {
        feePayer = undefined;
      });
    }
    return feePayer;
  };
  const signVerified = async (transaction: Uint8Array) => {
    const signedTransaction = await provider.signAsFeePayer(transaction);
    const decoded = await assertSponsorSignedSameMessage({
      requested: transaction,
      sponsorSigned: signedTransaction,
      sponsor: await sponsor(),
    });
    return { signedTransaction, decoded };
  };
  return {
    providerId: provider.providerId,
    getFeePayer: () => sponsor(),
    signAsFeePayer: async (transaction) => (await signVerified(transaction)).signedTransaction,
    signAndSend: (transaction) => provider.signAndSend(transaction),
    ...(getSponsorshipConfiguration
      ? {
          getSponsorshipConfiguration: () => getSponsorshipConfiguration.call(provider),
        }
      : {}),
    async prepareOwnedSubmission(transaction, lifecycle) {
      const { decoded } = await signVerified(transaction);
      const submission = {
        ...getFullySignedSubmission(decoded),
        releaseDefinitelyUnbroadcast: async () => {},
      };
      await lifecycle.persistSigned(submission);
      await lifecycle.markStarted();
      return submission;
    },
  };
}

type AppContext = Context<{ Bindings: Env }>;

function requireScopeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError("INTERNAL_ERROR", `${label} is required`);
  }
  return encodeURIComponent(normalized);
}

/**
 * Build the only Kora `user_id` shape emitted by authenticated SDP paths.
 *
 * Every segment comes from authentication middleware or persisted tenant data;
 * transaction payloads and public caller input never participate in the quota
 * identity.
 */
export function buildKoraUserId(scope: SponsorshipScope): string {
  const environment = requireScopeSegment(scope.environment, "Sponsorship environment");
  const organizationId = requireScopeSegment(scope.organizationId, "Sponsorship organization id");
  const tenantScope =
    scope.projectId === null
      ? "organization"
      : `project:${requireScopeSegment(scope.projectId, "Sponsorship project id")}`;
  const actorType = requireScopeSegment(scope.actor.type, "Sponsorship actor type");
  const actorId = requireScopeSegment(scope.actor.id, "Sponsorship actor id");

  return `sdp:v1:${environment}:${organizationId}:${tenantScope}:${actorType}:${actorId}`;
}

/**
 * Owned application boundary for constructing a fee-payment provider on the open cluster scope's
 * cluster: the scope's Kora signs, and managed deployments charge the scope cluster's budget.
 *
 * @param env - Environment carrying the fee-payment configuration.
 * @param scope - Who the sponsorship is charged to.
 * @param scope.environment - The owning project's environment.
 * @param scope.organizationId - The owning organization.
 * @param scope.projectId - The owning project, or null for organization scope.
 * @param scope.actor - The server-derived actor the Kora quota is keyed by.
 * @returns The sponsorship fee payment for the scope's cluster.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createSponsorshipFeePayment(
  env: Env,
  scope: SponsorshipScope
): SponsorshipFeePayment {
  const provider = instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(env, buildKoraUserId(scope))
  );
  return isSelfHostedDeployment(env)
    ? withOwnedSubmissionLifecycle(provider)
    : new BudgetedFeePayment(env, scope, provider);
}

/**
 * Read the open cluster scope's Kora security configuration through the same owned construction
 * boundary.
 *
 * @param env - Environment carrying the fee-payment configuration.
 * @returns The scope cluster's provider configuration.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora configured
 *   or the provider does not expose its configuration.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function getManagedSponsorshipProviderConfiguration(
  env: Env
): Promise<SponsorshipProviderConfiguration> {
  const provider = instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(env, "sdp:v1:system:sponsorship-reconciliation")
  );
  if (!provider.getSponsorshipConfiguration) {
    throw new FeePaymentError(
      "Managed sponsorship provider does not expose fail-closed configuration",
      "PROVIDER_NOT_AVAILABLE"
    );
  }
  return provider.getSponsorshipConfiguration();
}

/**
 * Compatibility boundary for self-hosted consumers without tenant context, on the open cluster
 * scope's cluster.
 *
 * @param env - Environment carrying the fee-payment configuration.
 * @returns The fee payment for the scope's cluster.
 * @throws AppError `FORBIDDEN` on a managed deployment.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createUnscopedSponsorshipFeePayment(env: Env): FeePaymentPort {
  if (!isSelfHostedDeployment(env)) {
    throw new AppError(
      "FORBIDDEN",
      "Managed sponsorship requires a trusted organization or project scope"
    );
  }
  return withOwnedSubmissionLifecycle(
    instrumentVendorPort(resolveFeePaymentProvider(env), createFeePaymentAdapter(env))
  );
}

/** Resolve a scope exclusively from trusted request middleware state. */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipScope {
  const scope = resolveAuthenticatedSponsorshipScope(c);
  return { ...scope, projectId: requireProjectId(c) };
}

/**
 * Resolve either project or organization scope from trusted authentication state. The environment
 * is the open cluster scope's; the paymaster and budget read the same scope's cluster.
 *
 * @param c - The request context, inside the project middleware's cluster scope.
 * @returns The sponsorship scope.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function resolveAuthenticatedSponsorshipScope(c: AppContext): SponsorshipScope {
  const auth = getAuth(c);
  const { environment } = currentClusterScope();

  return {
    environment,
    organizationId: auth.organizationId,
    projectId: c.get("projectId") ?? auth.projectId ?? null,
    actor:
      auth.authType === "api_key"
        ? { type: "api_key", id: auth.id }
        : { type: "user", id: auth.id },
  };
}

export function createRequestSponsorshipFeePayment(c: AppContext): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, resolveRequestSponsorshipScope(c));
}

export function createAuthenticatedSponsorshipFeePayment(c: AppContext): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, resolveAuthenticatedSponsorshipScope(c));
}

/**
 * Resolve service/background sponsorship from persisted project ownership, on the open cluster
 * scope's cluster. The actor id must itself come from persisted service state (for example a
 * custody wallet id), never a public request field.
 *
 * @param env - Environment carrying the fee-payment configuration.
 * @param input - The persisted owner of the sponsored work.
 * @param input.organizationId - The organization that must own the project.
 * @param input.projectId - The project the sponsorship is charged to.
 * @param input.actor - The server-derived actor the Kora quota is keyed by.
 * @returns The sponsorship fee payment for the scope's cluster.
 * @throws AppError `FORBIDDEN` when the project is missing, inactive, or another organization's.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function createProjectSponsorshipFeePayment(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    actor: SponsorshipScope["actor"];
  }
): Promise<SponsorshipFeePayment> {
  const project = await new ProjectService(getDb(env)).getProject(input.projectId);
  if (!project || project.organizationId !== input.organizationId || project.status !== "active") {
    throw new AppError("FORBIDDEN", "Sponsorship project is not active or accessible");
  }

  return createSponsorshipFeePayment(env, {
    environment: project.environment,
    organizationId: project.organizationId,
    projectId: project.id,
    actor: input.actor,
  });
}
