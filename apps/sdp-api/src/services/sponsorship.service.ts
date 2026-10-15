import {
  createFeePaymentAdapter,
  FeePaymentError,
  type FeePaymentPort,
  resolveFeePaymentProvider,
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
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";
import { assertSponsorshipAdmitted, readSponsorshipAdmissionFacts } from "./sponsorship-admission";
import { BudgetedFeePayment, getFullySignedSubmission } from "./sponsorship-budget.service";
import { assertSponsorSignedSameMessage } from "./sponsorship-integrity";

export type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

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
  /**
   * The movement the sponsored transaction serves. The sponsor refuses to sign
   * a start the organization may not make right now (HOO-1955).
   */
  movement: MovementId;
}

/** A scope that only ever names the fee payer, never signs. */
export type SponsorshipAddressScope = Omit<SponsorshipScope, "movement">;

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
  admission: { env: Env; scope: SponsorshipScope }
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
export function buildKoraUserId(scope: SponsorshipAddressScope): string {
  const environment = requireScopeSegment(scope.environment, "Sponsorship environment");
  const organizationId = requireScopeSegment(scope.organizationId, "Sponsorship organization id");
  const projectId = requireScopeSegment(scope.projectId, "Sponsorship project id");
  const actorType = requireScopeSegment(scope.actor.type, "Sponsorship actor type");
  const actorId = requireScopeSegment(scope.actor.id, "Sponsorship actor id");

  return `sdp:v1:${environment}:${organizationId}:project:${projectId}:${actorType}:${actorId}`;
}

/** Owned application boundary for constructing a fee-payment provider. */
export function createSponsorshipFeePayment(
  env: Env,
  scope: SponsorshipScope
): SponsorshipFeePayment {
  const provider = instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(
      env,
      buildKoraUserId(scope),
      CLUSTER_BY_SDP_ENVIRONMENT[scope.environment]
    )
  );
  return isSelfHostedDeployment(env)
    ? withOwnedSubmissionLifecycle(provider, { env, scope })
    : new BudgetedFeePayment(env, scope, provider);
}

/**
 * The fee payer a sponsored transaction will name, for flows that build a
 * transaction someone else signs and submits. Returns only the address: no
 * way to sponsor-sign escapes it, so it needs no movement.
 */
export function resolveSponsoredFeePayer(
  env: Env,
  scope: SponsorshipAddressScope
): Promise<Address> {
  return instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(
      env,
      buildKoraUserId(scope),
      CLUSTER_BY_SDP_ENVIRONMENT[scope.environment]
    )
  ).getFeePayer();
}

/** Read Kora security configuration through the same owned construction boundary. */
export async function getManagedSponsorshipProviderConfiguration(
  env: Env,
  cluster: SolanaCluster
): Promise<SponsorshipProviderConfiguration> {
  const provider = instrumentVendorPort(
    resolveFeePaymentProvider(env),
    createFeePaymentAdapter(env, "sdp:v1:system:sponsorship-reconciliation", cluster)
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
 * Resolve the request's sponsorship scope. Project and environment come from the open cluster
 * scope the project middleware opened, so the paymaster, the budget and the network-fee read
 * follow the request's project; only the organization and actor come from authentication.
 *
 * @param c - The request context, inside the project middleware's cluster scope.
 * @returns The sponsorship scope.
 * @throws AppError 400 when the open scope has no project.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipAddressScope {
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

export function createRequestSponsorshipFeePayment(
  c: AppContext,
  movement: MovementId
): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, { ...resolveRequestSponsorshipScope(c), movement });
}

/**
 * The fee payer for the request's sponsorship scope.
 *
 * @param c - The request context, inside the project middleware's cluster scope.
 * @returns The sponsored fee payer address.
 */
export function resolveRequestSponsoredFeePayer(c: AppContext): Promise<Address> {
  return resolveSponsoredFeePayer(c.env, resolveRequestSponsorshipScope(c));
}

/**
 * Resolve service/background sponsorship from persisted project ownership.
 * The actor id must itself come from persisted service state (for example a
 * custody wallet id), never a public request field.
 */
export async function createProjectSponsorshipFeePayment(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    actor: SponsorshipScope["actor"];
    movement: MovementId;
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
    movement: input.movement,
  });
}
