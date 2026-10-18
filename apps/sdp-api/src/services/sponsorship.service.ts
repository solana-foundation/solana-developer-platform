import {
  createFeePaymentAdapter,
  FeePaymentError,
  type FeePaymentPort,
  resolveFeePaymentProvider,
  resolveKoraEndpoint,
  type SponsorshipProviderConfiguration,
} from "@sdp/fee-payment";
import { currentClusterScope } from "@sdp/rpc/scope";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type MovementId,
  type ProjectEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";
import { assertSponsorshipAdmitted, readSponsorshipAdmissionFacts } from "./sponsorship-admission";
import { BudgetedFeePayment, getFullySignedSubmission } from "./sponsorship-budget.service";
import { assertSponsorSignedSameMessage } from "./sponsorship-integrity";

type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

export interface SponsorshipScope {
  /**
   * The project's environment. It alone decides the cluster (`CLUSTER_BY_SDP_ENVIRONMENT`), so the
   * Kora endpoint, the budget policies and the network-fee RPC always follow the project, never
   * the process default.
   */
  environment: ProjectEnvironment;
  organizationId: string;
  projectId: string;
  actor: {
    type: SponsorshipActorType;
    id: string;
  };
}

/**
 * A scope bound to the movement it serves, built only inside `createSponsorshipFeePayment`. The
 * sponsor refuses to sign a start the organization may not make right now (HOO-1955).
 */
export type SponsorshipMovementScope = SponsorshipScope & { movement: MovementId };

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

/**
 * Self-hosted sponsorship: checks money admission before each sponsor
 * signature (one organization read; none for an exit).
 */
function withOwnedSubmissionLifecycle(
  provider: FeePaymentPort,
  admission: { env: Env; scope: SponsorshipMovementScope }
): SponsorshipFeePayment {
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
  const admit = async () => {
    assertSponsorshipAdmitted(
      admission.scope,
      await readSponsorshipAdmissionFacts(admission.env, admission.scope)
    );
  };
  const signVerified = async (transaction: Uint8Array) => {
    await admit();
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
    signAndSend: async (transaction) => {
      await admit();
      return provider.signAndSend(transaction);
    },
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
function buildKoraUserId(scope: SponsorshipScope): string {
  const environment = requireScopeSegment(scope.environment, "Sponsorship environment");
  const organizationId = requireScopeSegment(scope.organizationId, "Sponsorship organization id");
  const projectId = requireScopeSegment(scope.projectId, "Sponsorship project id");
  const actorType = requireScopeSegment(scope.actor.type, "Sponsorship actor type");
  const actorId = requireScopeSegment(scope.actor.id, "Sponsorship actor id");

  return `sdp:v1:${environment}:${organizationId}:project:${projectId}:${actorType}:${actorId}`;
}

/**
 * The one construction of a fee-payment adapter: every sponsor, address read and configuration read
 * goes through it, so they share the Kora endpoint selection and the vendor-call instrumentation.
 *
 * @param env - API environment for provider configuration.
 * @param userId - The Kora `user_id` the adapter forwards.
 * @param cluster - The cluster the adapter sponsors on.
 * @returns The instrumented adapter.
 */
function instrumentedAdapter(env: Env, userId: string, cluster: SolanaCluster): FeePaymentPort {
  return instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(env, userId, cluster)
  );
}

/**
 * The only sponsor that can sign: binds the scope to its movement, then wraps the adapter in money
 * admission and the budget (managed) or the owned submission lifecycle (self-hosted).
 *
 * @param env - API environment for provider, database and Redis access.
 * @param scope - Who is sponsored.
 * @param movement - The movement the sponsored transaction serves.
 * @returns The sponsor.
 */
export function createSponsorshipFeePayment(
  env: Env,
  scope: SponsorshipScope,
  movement: MovementId
): SponsorshipFeePayment {
  const admitted: SponsorshipMovementScope = { ...scope, movement };
  const provider = instrumentedAdapter(
    env,
    buildKoraUserId(admitted),
    CLUSTER_BY_SDP_ENVIRONMENT[admitted.environment]
  );
  return isSelfHostedDeployment(env)
    ? withOwnedSubmissionLifecycle(provider, { env, scope: admitted })
    : new BudgetedFeePayment(env, admitted, provider);
}

/**
 * The fee payer a sponsored transaction will name, for flows that build a
 * transaction someone else signs and submits. Returns only the address: no
 * way to sponsor-sign escapes it, so it needs no movement.
 */
export function resolveSponsoredFeePayer(env: Env, scope: SponsorshipScope): Promise<Address> {
  return instrumentedAdapter(
    env,
    buildKoraUserId(scope),
    CLUSTER_BY_SDP_ENVIRONMENT[scope.environment]
  ).getFeePayer();
}

/**
 * Whether a Kora serves the scope's cluster, so a flow that may degrade to signer-paid fees can
 * decide before it asks for a sponsor.
 *
 * @param env - API environment naming the per-cluster Kora endpoints.
 * @param scope - Who would be sponsored.
 * @returns True when the scope's cluster has a Kora endpoint.
 */
export function isKoraSponsorshipConfigured(env: Env, scope: SponsorshipScope): boolean {
  return resolveKoraEndpoint(env, CLUSTER_BY_SDP_ENVIRONMENT[scope.environment]) !== null;
}

/** Read Kora security configuration through the same owned construction boundary. */
export async function getManagedSponsorshipProviderConfiguration(
  env: Env,
  cluster: SolanaCluster
): Promise<SponsorshipProviderConfiguration> {
  const provider = instrumentedAdapter(env, "sdp:v1:system:sponsorship-reconciliation", cluster);
  if (!provider.getSponsorshipConfiguration) {
    throw new FeePaymentError(
      "Managed sponsorship provider does not expose fail-closed configuration",
      "PROVIDER_NOT_AVAILABLE"
    );
  }
  return provider.getSponsorshipConfiguration();
}

/**
 * Resolve the request's sponsorship scope. Project and environment come from the open cluster
 * scope the project middleware opened, so the paymaster, the budget and the network-fee read
 * follow the request's project; only the organization and actor come from authentication.
 *
 * @param c - The request context, inside the project middleware's cluster scope.
 * @returns The sponsorship scope.
 * @throws AppError 400 when the open scope has no project.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipScope {
  const auth = getAuth(c);
  const { projectId, environment } = currentClusterScope();
  if (projectId === null) {
    throw badRequest("Project scope is required");
  }

  return {
    environment,
    organizationId: auth.organizationId,
    projectId,
    actor:
      auth.authType === "api_key"
        ? { type: "api_key", id: auth.id }
        : { type: "user", id: auth.id },
  };
}

/**
 * Resolve a sponsorship scope from persisted project ownership, for work with no request (jobs,
 * `/pay`) or that acts for a stored owner. The environment comes from the project row, so the
 * cluster follows the project.
 *
 * @param env - API environment for database access.
 * @param owner - The persisted owner of the sponsored work.
 * @param owner.organizationId - The organization the project must belong to.
 * @param owner.projectId - The project the work belongs to.
 * @param owner.actor - The quota actor; its id comes from persisted service state (for example a
 *   custody wallet id), never a public request field.
 * @returns The sponsorship scope.
 * @throws AppError `FORBIDDEN` when the project is missing, inactive or in another organization.
 */
export async function resolveProjectSponsorshipScope(
  env: Env,
  owner: { organizationId: string; projectId: string; actor: SponsorshipScope["actor"] }
): Promise<SponsorshipScope> {
  const project = await new ProjectService(getDb(env)).getProject(owner.projectId);
  if (!project || project.organizationId !== owner.organizationId || project.status !== "active") {
    throw new AppError("FORBIDDEN", "Sponsorship project is not active or accessible");
  }

  return {
    environment: project.environment,
    organizationId: project.organizationId,
    projectId: project.id,
    actor: owner.actor,
  };
}
