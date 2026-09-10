import {
  createFeePaymentAdapter,
  FeePaymentError,
  type FeePaymentPort,
  resolveFeePaymentProvider,
  type SponsorshipProviderConfiguration,
} from "@sdp/payments/fee-payment";
import type { ProjectEnvironment } from "@sdp/types";
import {
  type Address,
  bytesEqual,
  getTransactionDecoder,
  type Signature,
  type Transaction,
} from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { isSelfHostedDeployment } from "@/lib/runtime-env";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ProjectService } from "./project.service";
import { BudgetedFeePayment, getFullySignedSubmission } from "./sponsorship-budget.service";

export type SponsorshipActorType = "api_key" | "project" | "user" | "wallet";

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

/**
 * Refuses paymaster bytes that are not the sponsor's signature over exactly
 * the message SDP compiled.
 *
 * A paymaster returns bytes rather than a signature, so it could substitute a
 * different message while still providing a valid fee-payer signature. This
 * check also forbids relayers from injecting instructions after SDP simulated
 * or size-checked the transaction.
 *
 * @param params - The compiled transaction, returned bytes, and expected sponsor.
 * @param params.unsignedOrPartiallySigned - The transaction SDP handed to the sponsor.
 * @param params.sponsorSigned - The bytes returned by the sponsor.
 * @param params.sponsor - The address whose signature must be present.
 * @returns The decoded sponsor-signed transaction.
 */
export function assertSponsorSignedSameMessage(params: {
  unsignedOrPartiallySigned: Transaction;
  sponsorSigned: Uint8Array;
  sponsor: Address;
}): Transaction {
  const sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  if (!bytesEqual(sponsorSigned.messageBytes, params.unsignedOrPartiallySigned.messageBytes)) {
    throw new Error("Sponsored transaction came back over a different message");
  }
  if (
    sponsorSigned.signatures[params.sponsor] === null ||
    sponsorSigned.signatures[params.sponsor] === undefined
  ) {
    throw new Error("Sponsored transaction is missing the sponsor fee-payer signature");
  }
  return sponsorSigned;
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
  return {
    providerId: provider.providerId,
    getFeePayer: () => provider.getFeePayer(),
    signAsFeePayer: (transaction) => provider.signAsFeePayer(transaction),
    signAndSend: (transaction) => provider.signAndSend(transaction),
    ...(getSponsorshipConfiguration
      ? {
          getSponsorshipConfiguration: () => getSponsorshipConfiguration.call(provider),
        }
      : {}),
    async prepareOwnedSubmission(transaction, lifecycle) {
      const signedTransaction = await provider.signAsFeePayer(transaction);
      const submission = {
        ...getFullySignedSubmission(signedTransaction),
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

/** Owned application boundary for constructing a fee-payment provider. */
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

/** Read Kora security configuration through the same owned construction boundary. */
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

/** Compatibility boundary for self-hosted consumers without tenant context. */
export function createUnscopedSponsorshipFeePayment(env: Env): FeePaymentPort {
  if (!isSelfHostedDeployment(env)) {
    throw new AppError(
      "FORBIDDEN",
      "Managed sponsorship requires a trusted organization or project scope"
    );
  }
  return instrumentVendorPort(resolveFeePaymentProvider(env), createFeePaymentAdapter(env));
}

/** Resolve a scope exclusively from trusted request middleware state. */
export function resolveRequestSponsorshipScope(c: AppContext): SponsorshipScope {
  const scope = resolveAuthenticatedSponsorshipScope(c);
  return { ...scope, projectId: requireProjectId(c) };
}

/** Resolve either project or organization scope from trusted authentication state. */
export function resolveAuthenticatedSponsorshipScope(c: AppContext): SponsorshipScope {
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

export function createRequestSponsorshipFeePayment(c: AppContext): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, resolveRequestSponsorshipScope(c));
}

export function createAuthenticatedSponsorshipFeePayment(c: AppContext): SponsorshipFeePayment {
  return createSponsorshipFeePayment(c.env, resolveAuthenticatedSponsorshipScope(c));
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
