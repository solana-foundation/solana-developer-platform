import {
  isMovementId,
  type LegacyMovementModule,
  MOVEMENTS,
  type MovementId,
  type MovementKind,
  normalizeOrganizationTier,
  type OrganizationSettings,
  type OrganizationTier,
  type ProjectEnvironment,
  type ProjectStatus,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpRampProviderStages,
} from "@sdp/types";
import { AppError } from "@/lib/errors";
import { isModuleAvailable } from "@/lib/feature-flags";
import {
  decideMoneyStart,
  type MoneyAdmissionFacts,
  type MoneyAdmissionRefusal,
  type MoneyAdmissionScope,
  MoneyMovementRefusedError,
  type MoneyStartContext,
  readMoneyAdmissionFacts,
} from "@/lib/money-admission";
import { logEvent } from "@/runtime/money-path-events";
import { parseOrganizationSettings } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

/**
 * The admitted-movement capability (HOO-1955, ADR in `docs/decisions/`).
 *
 * `admitMovement` is the only way to get an {@link AdmittedMovement}, and the
 * money sinks (custody signers, project sponsorship) accept nothing else. Code
 * that skips admission does not compile; a forged or cast token fails at the
 * sink, because a sink can only read a token through
 * {@link readAdmittedMovement}, which checks it was minted here.
 *
 * The token carries the facts admission read (project environment and status,
 * organization tier and settings), so the sinks act on the same snapshot the
 * decision used and read nothing again.
 */

export type LegacyMovementId = `legacy.${LegacyMovementModule}`;

export interface AdmittedMovementFacts {
  readonly organizationId: string;
  readonly projectId: string;
  readonly movement: MovementId | LegacyMovementId;
  readonly kind: MovementKind;
  readonly environment: ProjectEnvironment;
  readonly projectStatus: ProjectStatus;
  readonly organization: {
    readonly tier: OrganizationTier;
    readonly settings: OrganizationSettings | null;
  };
}

let mint: (facts: AdmittedMovementFacts) => AdmittedMovement;

export class AdmittedMovement {
  readonly #facts: AdmittedMovementFacts;

  private constructor(facts: AdmittedMovementFacts) {
    this.#facts = Object.freeze({
      ...facts,
      organization: Object.freeze({ ...facts.organization }),
    });
    Object.freeze(this);
  }

  static {
    mint = (facts) => new AdmittedMovement(facts);
  }

  /** {@link readAdmittedMovement}. */
  static read(
    token: AdmittedMovement,
    scope?: { organizationId: string; projectId?: string | null }
  ): AdmittedMovementFacts {
    if (!(#facts in token)) {
      throw new AppError("INTERNAL_ERROR", "Value movement was not admitted");
    }
    const facts = token.#facts;
    if (
      scope &&
      (scope.organizationId !== facts.organizationId ||
        (scope.projectId != null && scope.projectId !== facts.projectId))
    ) {
      throw new AppError("FORBIDDEN", "Value movement was admitted for a different scope");
    }
    return facts;
  }
}

/**
 * The only way a sink reads a token. Throws unless it was minted by admission
 * and, when given a scope, unless it covers that scope.
 */
export function readAdmittedMovement(
  token: AdmittedMovement,
  scope?: { organizationId: string; projectId?: string | null }
): AdmittedMovementFacts {
  return AdmittedMovement.read(token, scope);
}

function mintFrom(
  scope: MoneyAdmissionScope,
  facts: MoneyAdmissionFacts,
  movement: MovementId | LegacyMovementId,
  kind: MovementKind
): AdmittedMovement {
  return mint({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    movement,
    kind,
    environment: facts.projectEnvironment,
    projectStatus: facts.projectStatus,
    organization: {
      tier: normalizeOrganizationTier(facts.organizationTier),
      settings: parseOrganizationSettings(facts.rawSettings),
    },
  });
}

export interface AdmitMovementOptions {
  /** `SDP_RAMP_PROVIDER_STAGES`; HTTP passes the request's own table. */
  rampProviderStages?: SdpRampProviderStages;
}

/**
 * The one admission point for money movement. One uncached primary-key join;
 * every refusal emits one `sdp_money_refused` event and throws
 * {@link MoneyMovementRefusedError} (403).
 *
 * | Organization         | Project                                 | Start  | Exit  |
 * | -------------------- | --------------------------------------- | ------ | ----- |
 * | active               | sandbox, or production with entitlement | admit  | admit |
 * | active               | production without the entitlement      | refuse | admit |
 * | suspended or deleted | any                                     | refuse | admit |
 *
 * The movement's module must also be in the deployment's release channel; the
 * job scheduler and `requireModule` already gate it, so this costs no read.
 */
export async function admitMovement(
  env: Env,
  scope: MoneyAdmissionScope,
  movement: MovementId,
  context: Omit<MoneyStartContext, "movement">,
  options: AdmitMovementOptions = {}
): Promise<AdmittedMovement> {
  const definition = MOVEMENTS[movement];
  if (
    !isModuleAvailable(
      env,
      definition.module,
      options.rampProviderStages ?? SDP_RAMP_PROVIDER_STAGES
    )
  ) {
    throw new AppError(
      "FORBIDDEN",
      `The ${definition.module} module is not available in this release channel.`
    );
  }
  const refuse = (reason: MoneyAdmissionRefusal): never => {
    logEvent("warn", {
      event: "sdp_money_refused",
      surface: context.surface,
      movement,
      kind: definition.kind,
      subject_id: context.subjectId,
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      reason,
    });
    throw new MoneyMovementRefusedError(reason);
  };
  const facts = await readMoneyAdmissionFacts(env, scope);
  if (!facts) {
    return refuse("project_not_found");
  }
  // Exits never ask (ADR 0002); the read still backs the token's facts.
  const decision =
    definition.kind === "exit" ? { admitted: true as const } : decideMoneyStart(facts);
  if (!decision.admitted) {
    return refuse(decision.reason);
  }
  return mintFrom(scope, facts, movement, definition.kind);
}

/**
 * ESCAPE HATCH (HOO-1955). Mints a token for a module that is not admitted
 * yet (`LEGACY_MOVEMENT_MODULES`). It reads the same join, so the sinks keep
 * their tier and project checks, but refuses nothing: those modules behave as
 * they did before admission existed. In shadow mode it logs what admission
 * would refuse (`decision: "would_refuse"`), so each module's slice starts
 * from data. `scripts/check-value-movement.mjs` pins which files may call it,
 * and the list may only shrink.
 */
export async function uncheckedLegacyMovement(
  env: Env,
  scope: MoneyAdmissionScope,
  module: LegacyMovementModule
): Promise<AdmittedMovement> {
  const facts = await readMoneyAdmissionFacts(env, scope);
  if (!facts) {
    throw new MoneyMovementRefusedError("project_not_found");
  }
  const decision = decideMoneyStart(facts);
  if (!decision.admitted) {
    logEvent("warn", {
      event: "sdp_money_refused",
      decision: "would_refuse",
      surface: "legacy",
      movement: `legacy.${module}`,
      kind: "start",
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      reason: decision.reason,
    });
  }
  return mintFrom(scope, facts, `legacy.${module}`, "start");
}

/**
 * Test-only minting: refuses to run outside Vitest, and
 * `scripts/check-value-movement.mjs` allows it only in test files.
 */
export function mintAdmittedMovementForTests(
  fields: Partial<AdmittedMovementFacts> & { organizationId: string; projectId: string }
): AdmittedMovement {
  if (!process.env.VITEST) {
    throw new Error("mintAdmittedMovementForTests is only available under Vitest");
  }
  const movement = fields.movement ?? "payments.transfer";
  return mint({
    movement,
    kind: isMovementId(movement) ? MOVEMENTS[movement].kind : "start",
    environment: "sandbox",
    projectStatus: "active",
    organization: { tier: normalizeOrganizationTier(undefined), settings: null },
    ...fields,
  });
}
