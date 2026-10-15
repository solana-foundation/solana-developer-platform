import { createHash } from "node:crypto";
import {
  createFeePaymentAdapter,
  FeePaymentError,
  type FeePaymentPort,
  resolveFeePaymentProvider,
  type SponsorshipProviderConfiguration,
} from "@sdp/fee-payment";
import type { MovementId, ProjectEnvironment, SolanaCluster } from "@sdp/types";
import { type Address, getTransactionDecoder, type Signature } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";
import { assertSponsorshipAdmitted, readSponsorshipAdmissionFacts } from "./sponsorship-admission";
import { BudgetedFeePayment, getFullySignedSubmission } from "./sponsorship-budget.service";
import { assertSponsorSignedSameMessage } from "./sponsorship-integrity";

export type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

/** Trusted identity for one managed sponsored transaction message, never a public selector. */
export interface SponsorshipAccountingIdentity {
  reservationId: string;
  attempt: number;
  network: "devnet" | "mainnet";
  environment: ProjectEnvironment;
  organizationId: string;
  projectId: string | null;
  actor: SponsorshipScope["actor"];
  transactionDigest: string;
  feePayer: string;
  providerConfigFingerprint: string;
}

export interface SponsorshipContinuity {
  /** Retained server-owned execution mode; changing deployment config is not absence proof. */
  deploymentMode: "managed" | "self_hosted";
  legacyActor: SponsorshipScope["actor"];
  exactActor: SponsorshipScope["actor"];
  /**
   * `legacy_new` is a genuinely new domain-owned window/message, never an
   * unlinked old claim. `after_writer_retirement` is a trusted release decision;
   * successful lookup must still prove absence. Existing work defaults to refusal.
   */
  admission: "continue_only" | "legacy_new" | "after_writer_retirement";
  /** Comes only from retained domain storage and is checked against accounting evidence. */
  reservationId?: string;
  /** Domain CAS must fence this specific message/payer/attempt before provider effects. */
  persistAccountingIdentity(identity: SponsorshipAccountingIdentity): Promise<void>;
}

export interface SponsorshipScope {
  environment: ProjectEnvironment;
  organizationId: string;
  projectId: string | null;
  actor: {
    type: SponsorshipActorType;
    id: string;
  };
  /**
   * The cluster the sponsored transaction executes on. Selects the Kora
   * endpoint, the budget policies and the network-fee RPC. Omitted means the
   * process default (`SOLANA_NETWORK`), which is what every flow that builds
   * against the process RPC wants; a flow that builds per cluster (Earn vault
   * movements) MUST pass the movement's cluster or a mainnet transaction is
   * signed by the devnet paymaster and charged to the devnet budget.
   */
  cluster?: SolanaCluster;
  continuity?: SponsorshipContinuity;
  /** The movement served by a new sponsor signature. */
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

function withOwnedSubmissionLifecycle(
  provider: FeePaymentPort,
  admission: { env: Env; scope: SponsorshipScope },
  assertAccounting?: (transaction: Uint8Array) => Promise<void>
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
    await assertAccounting?.(transaction);
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
      await assertAccounting?.(transaction);
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
  const tenantScope =
    scope.projectId === null
      ? "organization"
      : `project:${requireScopeSegment(scope.projectId, "Sponsorship project id")}`;
  const actorType = requireScopeSegment(scope.actor.type, "Sponsorship actor type");
  const actorId = requireScopeSegment(scope.actor.id, "Sponsorship actor id");

  return `sdp:v1:${environment}:${organizationId}:${tenantScope}:${actorType}:${actorId}`;
}

/** Owned application boundary for constructing a fee-payment provider. */
export function createSponsorshipFeePayment(
  env: Env,
  scope: SponsorshipScope
): SponsorshipFeePayment {
  const selfHosted = isSelfHostedDeployment(env);
  const continuity = scope.continuity;
  if (continuity && continuity.deploymentMode !== (selfHosted ? "self_hosted" : "managed")) {
    throw new FeePaymentError(
      "Deployment mode conflicts with retained sponsorship evidence",
      "PROVIDER_NOT_AVAILABLE"
    );
  }
  if (
    continuity &&
    ![continuity.legacyActor, continuity.exactActor].some(
      (actor) => actor.type === scope.actor.type && actor.id === scope.actor.id
    )
  ) {
    throw new FeePaymentError(
      "Sponsorship actor does not belong to this operation",
      "PROVIDER_NOT_AVAILABLE"
    );
  }
  const initialActor =
    selfHosted && continuity && continuity.admission !== "after_writer_retirement"
      ? continuity.legacyActor
      : scope.actor;
  const providerId = resolveFeePaymentProvider(env);
  const providers = new Map<string, FeePaymentPort>();
  const providerForActor = (actor: SponsorshipScope["actor"]) => {
    const userId = buildKoraUserId({ ...scope, actor });
    const cached = providers.get(userId);
    if (cached) return cached;
    const created = instrumentVendorPort(
      providerId,
      createFeePaymentAdapter(env, userId, scope.cluster)
    );
    providers.set(userId, created);
    return created;
  };
  // Continuations prove the retained actor before constructing its provider.
  // Unrelated callers keep their eager construction behavior.
  let lazyProvider: FeePaymentPort | undefined;
  const getProvider = () => (lazyProvider ??= providerForActor(initialActor));
  const provider: FeePaymentPort = scope.continuity
    ? {
        providerId,
        getFeePayer: () => getProvider().getFeePayer(),
        signAsFeePayer: (transaction) => getProvider().signAsFeePayer(transaction),
        signAndSend: (transaction) => getProvider().signAndSend(transaction),
        getSponsorshipConfiguration: async () => {
          const selected = getProvider();
          if (!selected.getSponsorshipConfiguration) {
            throw new FeePaymentError(
              "Sponsorship provider configuration unavailable",
              "PROVIDER_NOT_AVAILABLE"
            );
          }
          return selected.getSponsorshipConfiguration();
        },
      }
    : providerForActor(scope.actor);
  return selfHosted
    ? withOwnedSubmissionLifecycle(
        provider,
        { env, scope },
        continuity
          ? async (transaction) => {
              const decoded = getTransactionDecoder().decode(transaction);
              const transactionDigest = createHash("sha256")
                .update(new Uint8Array(decoded.messageBytes))
                .digest("hex");
              const candidates = await new SponsorshipBudgetRepository(
                getDb(env)
              ).findReservationEvidence({
                organizationId: scope.organizationId,
                projectId: scope.projectId,
                transactionDigest,
                reservationId: continuity.reservationId,
              });
              if (candidates.length > 0 || continuity.reservationId !== undefined) {
                throw new FeePaymentError(
                  "Managed accounting evidence requires a compatible managed reader",
                  "PROVIDER_NOT_AVAILABLE"
                );
              }
            }
          : undefined
      )
    : new BudgetedFeePayment(env, scope, provider, { providerForActor });
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
    createFeePaymentAdapter(env, buildKoraUserId(scope), scope.cluster)
  ).getFeePayer();
}

/** Read Kora security configuration through the same owned construction boundary. */
export async function getManagedSponsorshipProviderConfiguration(
  env: Env,
  cluster?: SolanaCluster
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

/** Resolve a scope exclusively from trusted request middleware state. */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipAddressScope {
  const scope = resolveAuthenticatedSponsorshipScope(c);
  return { ...scope, projectId: requireProjectId(c) };
}

/** Resolve either project or organization scope from trusted authentication state. */
export function resolveAuthenticatedSponsorshipScope(c: AppContext): SponsorshipAddressScope {
  const auth = getAuth(c);
  const environment = resolveSdpEnvironment(c);

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

export function createRequestSponsorshipFeePayment(
  c: AppContext,
  movement: MovementId
): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, { ...resolveRequestSponsorshipScope(c), movement });
}

/** The fee payer for the request's authenticated scope (project or organization). */
export function resolveAuthenticatedSponsoredFeePayer(c: AppContext): Promise<Address> {
  return resolveSponsoredFeePayer(c.env, resolveAuthenticatedSponsorshipScope(c));
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
    cluster?: SolanaCluster;
    continuity?: SponsorshipContinuity;
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
    cluster: input.cluster,
    continuity: input.continuity,
    movement: input.movement,
  });
}
