import {
  MOVEMENTS,
  type MovementId,
  organizationStatusMayStartMoney,
  type ProjectEnvironment,
} from "@sdp/types";
import { getDb } from "@/db";
import type { DatabaseExecutor } from "@/db/client";
import { AppError } from "@/lib/errors";
import { parseOrganizationEntitlements } from "@/lib/production-entitlement";
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

/**
 * Money admission (HOO-1955): whether an organization's project may start new
 * money movement right now.
 *
 * Background jobs and `/pay` move money without an authenticated actor, so no
 * HTTP edge check (API-key auth, `projectContextMiddleware`) has looked at the
 * organization for them. They ask here before every new signature. Work that is
 * already signed only confirms, and never asks.
 *
 * | Organization         | Project                                  | Start   |
 * | -------------------- | ---------------------------------------- | ------- |
 * | active               | sandbox, or production with entitlement  | admit   |
 * | active               | production without the entitlement       | refuse  |
 * | suspended or deleted | any                                      | refuse  |
 *
 * Exits (taking money already committed back out) are never refused (ADR 0002)
 * and never ask. The read is uncached on purpose: deletion and revocation take
 * effect on the next movement.
 */

export type MoneyAdmissionRefusal =
  | "project_not_found"
  | "organization_inactive"
  | "production_not_enabled";

export interface MoneyAdmissionScope {
  organizationId: string;
  projectId: string;
}

export interface MoneyAdmissionFacts {
  /** The raw `organizations.status` column. */
  organizationStatus: string;
  projectEnvironment: ProjectEnvironment;
  /** The raw `organizations.settings` column. */
  rawSettings: string | null;
}

export type MoneyAdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: MoneyAdmissionRefusal };

/** What is asking to start money, for the refusal event. */
export interface MoneyStartContext {
  surface: "job" | "http";
  operation:
    | "recurring_payment.collect"
    | "recurring_payment.activate"
    | "recurring_payment.resume"
    | "pay_request.sponsor";
  /** The row the movement belongs to, such as a recurring payment id. */
  subjectId: string;
}

const REFUSAL_MESSAGES: Record<MoneyAdmissionRefusal, string> = {
  project_not_found: "Project not found",
  organization_inactive: "Organization is not active",
  // Matches `productionNotEnabled()`, the edge refusal for the same reason.
  production_not_enabled: "Production is not enabled for this organization",
};

export class MoneyMovementRefusedError extends AppError {
  readonly reason: MoneyAdmissionRefusal;

  constructor(reason: MoneyAdmissionRefusal) {
    super("FORBIDDEN", REFUSAL_MESSAGES[reason], { reason });
    this.name = "MoneyMovementRefusedError";
    this.reason = reason;
  }
}

/**
 * Pure. Settings are parsed only for a production project of an active
 * organization, and a value that does not parse throws (fail closed, as at the
 * edge).
 */
export function decideMoneyStart(facts: MoneyAdmissionFacts | null): MoneyAdmissionDecision {
  if (!facts) {
    return { admitted: false, reason: "project_not_found" };
  }
  if (!organizationStatusMayStartMoney(facts.organizationStatus)) {
    return { admitted: false, reason: "organization_inactive" };
  }
  if (
    facts.projectEnvironment === "production" &&
    parseOrganizationEntitlements(facts.rawSettings).enableProductionProject !== true
  ) {
    return { admitted: false, reason: "production_not_enabled" };
  }
  return { admitted: true };
}

/**
 * Pure. What the custody signer decides for one movement: an exit always
 * passes (ADR 0002), and a start is {@link decideMoneyStart}.
 */
export function decideMovement(
  movement: MovementId,
  facts: MoneyAdmissionFacts | null
): MoneyAdmissionDecision {
  return MOVEMENTS[movement].kind === "exit" ? { admitted: true } : decideMoneyStart(facts);
}

/** Where a movement was refused, for the `sdp_money_refused` event. */
export interface MovementRefusalContext {
  surface: "signer" | "sponsor";
  movement: MovementId;
  organizationId: string;
  projectId: string | null;
  /** The custody wallet or sponsored actor the refusal is about. */
  subjectId: string;
}

/**
 * Throws {@link MoneyMovementRefusedError} (403) for a refused decision, after
 * emitting one `sdp_money_refused` event. The signing sinks call it at the
 * moment they are asked to sign.
 */
export function assertMovementAdmitted(
  decision: MoneyAdmissionDecision,
  context: MovementRefusalContext
): void {
  if (decision.admitted) {
    return;
  }
  logEvent("warn", {
    event: "sdp_money_refused",
    surface: context.surface,
    movement: context.movement,
    subject_id: context.subjectId,
    organization_id: context.organizationId,
    project_id: context.projectId,
    reason: decision.reason,
  });
  throw new MoneyMovementRefusedError(decision.reason);
}

/** One primary-key join, scoped by both ids. */
export async function readMoneyAdmissionFacts(
  env: Env,
  scope: MoneyAdmissionScope
): Promise<MoneyAdmissionFacts | null> {
  return readMoneyAdmissionFactsWith(getDb(env), scope);
}

/** {@link readMoneyAdmissionFacts} on a caller's client (a transaction, a service's own). */
export async function readMoneyAdmissionFactsWith(
  db: DatabaseExecutor,
  scope: MoneyAdmissionScope
): Promise<MoneyAdmissionFacts | null> {
  const row = await db
    .prepare(
      `SELECT p.environment, o.status, o.settings
         FROM projects p
         JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.organization_id = ?`
    )
    .bind(scope.projectId, scope.organizationId)
    .first<{ environment: ProjectEnvironment; status: string; settings: string | null }>();
  return row
    ? {
        organizationStatus: row.status,
        projectEnvironment: row.environment,
        rawSettings: row.settings,
      }
    : null;
}

/** Reads and decides. Every refusal emits one `sdp_money_refused` event. */
export async function checkMoneyStart(
  env: Env,
  scope: MoneyAdmissionScope,
  context: MoneyStartContext
): Promise<MoneyAdmissionDecision> {
  const decision = decideMoneyStart(await readMoneyAdmissionFacts(env, scope));
  if (!decision.admitted) {
    logEvent("warn", {
      event: "sdp_money_refused",
      surface: context.surface,
      operation: context.operation,
      subject_id: context.subjectId,
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      reason: decision.reason,
    });
  }
  return decision;
}

/** {@link checkMoneyStart}, throwing {@link MoneyMovementRefusedError} (403) on refusal. */
export async function assertMoneyStartAdmitted(
  env: Env,
  scope: MoneyAdmissionScope,
  context: MoneyStartContext
): Promise<void> {
  const decision = await checkMoneyStart(env, scope, context);
  if (!decision.admitted) {
    throw new MoneyMovementRefusedError(decision.reason);
  }
}
