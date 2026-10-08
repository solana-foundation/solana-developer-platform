import type {
  OrganizationSettings,
  OrganizationTier,
  ProjectEnvironment,
  ProjectStatus,
  RampProviderId,
  SdpModule,
  SdpRampProviderStages,
} from "@sdp/types";
import { normalizeOrganizationTier, SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { isModuleAvailable, isRampProviderAvailable } from "@/lib/feature-flags";
import { isProductionEntitled } from "@/lib/production-entitlement";
import { logEvent } from "@/runtime/money-path-events";
import { parseOrganizationSettings } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

/**
 * How a purpose relates to money the organization already committed (HOO-1955).
 *
 * - `start`: a new signature or provider payout that opens new exposure.
 * - `exit`: reduces exposure or returns funds already deployed (ADR 0002).
 *   Stays open for deleted organizations and after the production entitlement
 *   is revoked, so customers can always get their money out.
 * - `funded_payout`: finishes a movement the customer already funded outside
 *   SDP (a BVNK fiat pay-in that already arrived). Passes after revocation;
 *   a deleted organization holds it for an operator to refund or release.
 */
export type MovementKind = "start" | "exit" | "funded_payout";

interface PurposeDefinition {
  module: SdpModule;
  kind: MovementKind;
  /** Ramps are in a release channel per provider, not per module. */
  rampProvider?: RampProviderId;
}

/**
 * Every reason SDP may acquire a custody signer, a sponsored fee payer, or a
 * provider payout. Adding a purpose is a reviewed change: the exit set is
 * pinned by `security/value-moving-conformance.node.test.ts`.
 */
export const MOVEMENT_PURPOSES = {
  "custody.signer_check": { module: "custody", kind: "start" },
  "payments.transfer": { module: "payments", kind: "start" },
  "payments.transfer_batch": { module: "payments", kind: "start" },
  "payments.pay_request": { module: "payments", kind: "start" },
  "recurring.activate": { module: "recurring_payments", kind: "start" },
  "recurring.collect": { module: "recurring_payments", kind: "start" },
  "recurring.update": { module: "recurring_payments", kind: "start" },
  "recurring.resume": { module: "recurring_payments", kind: "start" },
  "recurring.cancel": { module: "recurring_payments", kind: "exit" },
  "issuance.execute": { module: "issuance", kind: "start" },
  "dvp.create": { module: "dvp", kind: "start" },
  "dvp.fund": { module: "dvp", kind: "start" },
  "dvp.settle": { module: "dvp", kind: "start" },
  "dvp.reclaim": { module: "dvp", kind: "exit" },
  "dvp.cancel": { module: "dvp", kind: "exit" },
  "earn.deposit": { module: "earn", kind: "start" },
  "earn.withdraw": { module: "earn", kind: "exit" },
  "private_channels.deposit": { module: "private_channels", kind: "start" },
  "private_channels.transfer": { module: "private_channels", kind: "start" },
  "private_channels.wallet_setup": { module: "private_channels", kind: "start" },
  "private_channels.withdraw": { module: "private_channels", kind: "exit" },
  "rings.operation": { module: "helius_rings", kind: "start" },
  "rings.setup": { module: "helius_rings", kind: "start" },
  "ramps.bvnk_onramp_payout": { module: "ramps", kind: "funded_payout", rampProvider: "bvnk" },
} as const satisfies Record<string, PurposeDefinition>;

export type MovementPurpose = keyof typeof MOVEMENT_PURPOSES;

export function movementKind(purpose: MovementPurpose): MovementKind {
  return MOVEMENT_PURPOSES[purpose].kind;
}

export type MovementRefusalReason =
  | "project_not_found"
  | "organization_inactive"
  | "production_not_enabled"
  | "module_not_in_release_channel";

export class MovementRefusedError extends AppError {
  readonly refusal: MovementRefusalReason;

  constructor(reason: MovementRefusalReason, message: string) {
    super(reason === "project_not_found" ? "NOT_FOUND" : "FORBIDDEN", message, { reason });
    this.refusal = reason;
  }
}

declare const admittedBrand: unique symbol;

/**
 * Proof that {@link admitMovement} checked this organization, project and
 * purpose. Sinks (custody signers, sponsored fee payers, provider payouts)
 * accept nothing else, so code that skips admission does not compile; a cast
 * fails at runtime because only tokens minted here are in `minted`.
 *
 * It also carries the organization and project facts the sinks used to read
 * again (custody tier entitlement, sponsorship environment and status), so the
 * admission join replaces those reads instead of adding one.
 */
export interface AdmittedMovement {
  readonly organizationId: string;
  readonly projectId: string;
  readonly purpose: MovementPurpose;
  readonly kind: MovementKind;
  readonly environment: ProjectEnvironment;
  readonly projectStatus: ProjectStatus;
  readonly organization: {
    readonly tier: OrganizationTier;
    readonly settings: OrganizationSettings | null;
  };
  readonly [admittedBrand]: true;
}

const minted = new WeakSet<object>();

function mint(fields: Omit<AdmittedMovement, typeof admittedBrand>): AdmittedMovement {
  const token = Object.freeze({
    ...fields,
    organization: Object.freeze({ ...fields.organization }),
  });
  minted.add(token);
  return token as AdmittedMovement;
}

/** Throws unless `movement` came from {@link admitMovement} and, when given, covers `scope`. */
export function assertAdmittedMovement(
  movement: AdmittedMovement,
  scope?: { organizationId: string; projectId?: string | null }
): void {
  if (!minted.has(movement)) {
    throw new AppError("INTERNAL_ERROR", "Value movement was not admitted");
  }
  if (
    scope &&
    (scope.organizationId !== movement.organizationId ||
      (scope.projectId != null && scope.projectId !== movement.projectId))
  ) {
    throw new AppError("FORBIDDEN", "Value movement was admitted for a different scope");
  }
}

export interface MovementScope {
  organizationId: string;
  projectId: string;
}

interface AdmissionRow {
  environment: ProjectEnvironment;
  project_status: ProjectStatus;
  organization_status: string;
  tier: string;
  settings: string | null;
}

export interface AdmitMovementOptions {
  /** `SDP_RAMP_PROVIDER_STAGES`; tests pass their own table. */
  rampProviderStages?: SdpRampProviderStages;
}

/**
 * The one admission point for value movement (HOO-1955): the policy decision
 * point whose result every sink requires. One primary-key join, read live on
 * every call (revocation and deletion take effect on the next movement).
 *
 * | organization | production entitlement | start | exit | funded_payout |
 * | ------------ | ---------------------- | ----- | ---- | ------------- |
 * | active       | granted / sandbox      | pass  | pass | pass          |
 * | active       | revoked (production)   | refuse| pass | pass          |
 * | deleted      | any, every environment | refuse| pass | refuse (hold) |
 *
 * The purpose's module (or ramp provider) must be in the deployment's
 * release channel for every kind: a module outside it is off everywhere.
 */
export async function admitMovement(
  env: Env,
  scope: MovementScope,
  purpose: MovementPurpose,
  options: AdmitMovementOptions = {}
): Promise<AdmittedMovement> {
  const definition: PurposeDefinition = MOVEMENT_PURPOSES[purpose];
  const stages = options.rampProviderStages ?? SDP_RAMP_PROVIDER_STAGES;
  const inChannel = definition.rampProvider
    ? isRampProviderAvailable(env, definition.rampProvider, stages)
    : isModuleAvailable(env, definition.module, stages);
  if (!inChannel) {
    throw new MovementRefusedError(
      "module_not_in_release_channel",
      `The ${definition.module} module is not available in this release channel.`
    );
  }

  const row = await getDb(env)
    .prepare(
      `SELECT p.environment, p.status AS project_status,
              o.status AS organization_status, o.tier, o.settings
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = ? AND p.organization_id = ?`
    )
    .bind(scope.projectId, scope.organizationId)
    .first<AdmissionRow>();
  if (!row) {
    throw new MovementRefusedError("project_not_found", "Project not found");
  }

  if (row.organization_status !== "active") {
    if (definition.kind !== "exit") {
      throw new MovementRefusedError("organization_inactive", "Organization is not active");
    }
  } else if (
    definition.kind === "start" &&
    row.environment === "production" &&
    !isProductionEntitled(row.settings, scope.organizationId)
  ) {
    throw new MovementRefusedError(
      "production_not_enabled",
      "Production is not enabled for this organization"
    );
  }

  return mint({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    purpose,
    kind: definition.kind,
    environment: row.environment,
    projectStatus: row.project_status,
    organization: {
      tier: normalizeOrganizationTier(row.tier),
      settings: parseOrganizationSettings(row.settings),
    },
  });
}

/**
 * The HTTP minting point. Scope comes only from authentication and
 * `projectContextMiddleware` (which already refused the request with a clean
 * 403 at the edge when it could); never from the request body or headers.
 */
export function admitRequestMovement(
  c: Context<{ Bindings: Env }>,
  purpose: MovementPurpose
): Promise<AdmittedMovement> {
  return admitMovement(
    c.env,
    { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) },
    purpose,
    { rampProviderStages: c.get("rampProviderStages") }
  );
}

/**
 * For background jobs: admission as a value, so each job applies its own
 * refusal semantics (skip, revert, fail, hold) and every refusal emits one
 * `sdp_background_money_refused` event.
 */
export async function tryAdmitMovement(
  env: Env,
  scope: MovementScope,
  purpose: MovementPurpose,
  context: { job: string; subjectId: string },
  options: AdmitMovementOptions = {}
): Promise<
  | { admitted: true; movement: AdmittedMovement }
  | { admitted: false; reason: MovementRefusalReason; error: MovementRefusedError }
> {
  try {
    return { admitted: true, movement: await admitMovement(env, scope, purpose, options) };
  } catch (error) {
    if (!(error instanceof MovementRefusedError)) throw error;
    logEvent("warn", {
      event: "sdp_background_money_refused",
      job: context.job,
      subject_id: context.subjectId,
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      purpose,
      reason: error.refusal,
    });
    return { admitted: false, reason: error.refusal, error };
  }
}

/**
 * Test-only minting. Throws outside Vitest; the conformance test pins that
 * only test files import it.
 */
export function mintAdmittedMovementForTests(
  fields: Partial<Omit<AdmittedMovement, typeof admittedBrand>> & {
    organizationId: string;
    projectId: string;
  }
): AdmittedMovement {
  if (!process.env.VITEST) {
    throw new Error("mintAdmittedMovementForTests is only available under Vitest");
  }
  const purpose = fields.purpose ?? "payments.transfer";
  return mint({
    purpose,
    kind: MOVEMENT_PURPOSES[purpose].kind,
    environment: "sandbox",
    projectStatus: "active",
    organization: { tier: normalizeOrganizationTier(undefined), settings: null },
    ...fields,
  });
}
