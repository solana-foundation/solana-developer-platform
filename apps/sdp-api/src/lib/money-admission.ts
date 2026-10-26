import { type Action, apiKeyMayPerform, organizationRoleMayPerform } from "@sdp/types/actions";
import { API_KEY_WALLET_SCOPES, type ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { CustodyWalletPurpose } from "@sdp/types/custody";
import {
  MANDATE_MOVEMENT_STATUSES,
  MOVEMENTS,
  type MovementId,
  movementActions,
  movementAllowsWalletPurpose,
  PAYMENT_REQUEST_MOVEMENT_STATUSES,
} from "@sdp/types/movements";
import {
  memberStatusMayMoveMoney,
  organizationStatusMayStartMoney,
} from "@sdp/types/organizations";
import type { ProjectEnvironment } from "@sdp/types/projects";
import { normalizeOrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import { type ApiKeyContext, walletAccessAllows } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  currentMoneyPrincipal,
  describeMoneyPrincipal,
  type MoneyPrincipal,
  type MoneyPrincipalKind,
} from "@/lib/money-principal";
import { parseOrganizationEntitlements } from "@/lib/production-entitlement";
import { logEvent } from "@/runtime/money-path-events";
import { parseGrantsColumn } from "@/services/api-key.service";
import type { Env } from "@/types/env";

/**
 * Money admission (HOO-1955, HOO-2099): whether a principal may start new
 * money movement in an organization's project right now, with this custody
 * wallet.
 *
 * The signing waists (custody signer, fee sponsor) ask on every start
 * signature; jobs, `/pay` and provider-API starts (ramp quotes) ask before
 * their first provider call or signature. All of them make the same single
 * read, {@link readMoneyAdmissionFactsWith}: the project and organization, and
 * the ambient principal's own row, joined into one primary-key statement. The
 * decision, {@link decideMovement}, is pure.
 *
 * | Organization         | Project                                  | Start   |
 * | -------------------- | ---------------------------------------- | ------- |
 * | active               | sandbox, or production with entitlement  | admit   |
 * | active               | production without the entitlement       | refuse  |
 * | suspended or deleted | any                                      | refuse  |
 *
 * Then the principal (see `lib/money-principal.ts`): a start with none is
 * refused; an API key must be live, hold one of the movement's actions and
 * have the signing wallet in its wallet scope; a member must be active, still
 * a member of the project (the `project_members` row the dashboard's project
 * scope is admitted by) and hold one of the actions through their role; a mandate (recurring payment)
 * must be in a status that admits the movement and sign only with its source
 * wallet; a `/pay` link signs only its open payment request.
 *
 * Exits (taking money already committed back out) are never refused by the
 * organization (ADR 0002): an exit with no principal reads nothing and is
 * admitted. An exit with a principal is read, and the credential can refuse
 * it: one that is no longer live, or a key whose scope lacks the wallet (ADR
 * 0007 addendum). The read is uncached on purpose: deletion and revocation
 * take effect on the next movement.
 */

export type MoneyAdmissionRefusal =
  | "project_not_found"
  | "organization_inactive"
  | "production_not_enabled"
  | "principal_missing"
  | "principal_not_live"
  | "action_not_held"
  | "wallet_out_of_scope"
  | "wallet_purpose";

export interface MoneyAdmissionScope {
  organizationId: string;
  projectId: string;
}

/** What the read found for the principal it was asked about. `null`: no such row in the project. */
export type MoneyPrincipalFacts =
  | { kind: "none" }
  | {
      kind: "api_key";
      key:
        | (ApiKeyLifecycleColumns & {
            grants: Action[];
            walletScope: ApiKeyWalletScope;
            /** Whether the asked-about custody wallet is listed; null when none was asked about. */
            walletListed: boolean | null;
          })
        | null;
    }
  | {
      kind: "member";
      member: {
        status: string;
        role: string;
        /** Whether the user still has a `project_members` row for the project. */
        inProject: boolean;
      } | null;
    }
  | {
      kind: "mandate";
      mandate: { status: string; sourceCustodyWalletId: string | null } | null;
    }
  | { kind: "payment_request"; request: { status: string; expiresAt: string | null } | null };

export interface MoneyAdmissionFacts {
  /** The raw `organizations.status` column. */
  organizationStatus: string;
  projectEnvironment: ProjectEnvironment;
  /** The raw `organizations.settings` column. */
  rawSettings: string | null;
  principal: MoneyPrincipalFacts;
  /** When the row was read (epoch ms), for key expiry. */
  readAt: number;
}

/** The organization half of {@link MoneyAdmissionFacts}. */
export type OrganizationAdmissionFacts = Pick<
  MoneyAdmissionFacts,
  "organizationStatus" | "projectEnvironment" | "rawSettings"
>;

/**
 * A refused decision. `action_not_held` names the movement's first action, so
 * its error reads like the route's own refusal.
 */
export type MoneyAdmissionRefused =
  | { admitted: false; reason: Exclude<MoneyAdmissionRefusal, "action_not_held"> }
  | { admitted: false; reason: "action_not_held"; action: Action };

export type MoneyAdmissionDecision = { admitted: true } | MoneyAdmissionRefused;

/**
 * What a start signs with. The custody signer names its wallet, and a sponsor
 * names the custody wallet whose transaction it pays for, so a key's wallet
 * scope decides both signatures. A sponsor with no custody wallet in the
 * transaction (`/pay`) and a provider-API start pass null, and then no
 * wallet-scope check applies.
 */
export interface MoneyAdmissionSubject {
  custodyWalletId: string | null;
}

/** What is asking to start money before it signs, for the refusal event. */
export interface MoneyStartContext {
  surface: "job" | "http";
  movement: MovementId;
  /** The row the movement belongs to, such as a recurring payment id. */
  subjectId: string;
}

const REFUSAL_MESSAGES: Record<Exclude<MoneyAdmissionRefusal, "action_not_held">, string> = {
  project_not_found: "Project not found",
  organization_inactive: "Organization is not active",
  // Matches `productionNotEnabled()`, the edge refusal for the same reason.
  production_not_enabled: "Production is not enabled for this organization",
  principal_missing: "No authenticated principal may move money here",
  principal_not_live: "The credential moving money is no longer active",
  wallet_out_of_scope: "The credential may not sign with this wallet",
  wallet_purpose: "Payments can only be sent from a transfer wallet",
};

type RefusalArguments =
  | [reason: Exclude<MoneyAdmissionRefusal, "action_not_held">]
  | [reason: "action_not_held", action: Action];

function refusalErrorArguments(refusal: RefusalArguments): ConstructorParameters<typeof AppError> {
  if (refusal[0] === "action_not_held") {
    const action = refusal[1];
    return ["INSUFFICIENT_PERMISSIONS", `Missing action: ${action}`, { action }];
  }
  return ["FORBIDDEN", REFUSAL_MESSAGES[refusal[0]], { reason: refusal[0] }];
}

/**
 * A waist's refusal (403). A missing action is `INSUFFICIENT_PERMISSIONS` with
 * `details.action`, the refusal `requireAction` gives at the route; every
 * other reason is `FORBIDDEN` with `details.reason`.
 */
export class MoneyMovementRefusedError extends AppError {
  readonly reason: MoneyAdmissionRefusal;

  constructor(...refusal: RefusalArguments) {
    super(...refusalErrorArguments(refusal));
    this.name = "MoneyMovementRefusedError";
    this.reason = refusal[0];
  }

  /** The error for a refused decision. */
  static of(decision: MoneyAdmissionRefused): MoneyMovementRefusedError {
    return decision.reason === "action_not_held"
      ? new MoneyMovementRefusedError(decision.reason, decision.action)
      : new MoneyMovementRefusedError(decision.reason);
  }
}

/**
 * Refuses, before any work, a request that names a custody wallet outside
 * the caller's wallet scope as read at authentication (HOO-2099): the custody
 * signer's own refusal, made early so a flow that records, claims an
 * Idempotency-Key or calls a gateway before it signs (Private Channels,
 * Rings, transfers, transfer batches, signer check) does none of it. Same
 * 403; the waist still decides every signature (ADR 0007 addendum).
 */
export function assertCallerWalletInScope(
  caller: Pick<ApiKeyContext, "walletAccess" | "organizationId" | "projectId">,
  custodyWalletId: string
): void {
  if (walletAccessAllows(caller.walletAccess, custodyWalletId)) return;
  logMoneyRefusedEarly(caller, custodyWalletId, "wallet_out_of_scope", null);
  throw new MoneyMovementRefusedError("wallet_out_of_scope");
}

/**
 * Refuses, before any work, a request whose source wallet may not sign the
 * movement: outside the caller's wallet scope ({@link assertCallerWalletInScope}),
 * then a purpose the movement does not allow ({@link assertWalletPurposeAdmitted}).
 * For flows that sign in the request (transfers, batches, ramp quotes); a
 * route asks here before its Idempotency-Key is claimed, so a refusal stores
 * nothing.
 *
 * @param caller - The authenticated caller, as read at authentication.
 * @param wallet - The custody wallet the movement would sign with.
 * @param wallet.id - Its custody wallet row id.
 * @param wallet.purpose - Its purpose; null for a wallet created before purposes.
 * @param movement - The movement the wallet would sign.
 */
export function assertCallerMaySignWith(
  caller: Pick<ApiKeyContext, "walletAccess" | "organizationId" | "projectId">,
  wallet: { id: string; purpose: CustodyWalletPurpose | null },
  movement: MovementId
): void {
  assertCallerWalletInScope(caller, wallet.id);
  assertWalletPurposeAdmitted(caller, wallet, movement);
}

/**
 * Refuses, before any work, a wallet whose purpose the movement does not
 * allow (APE-371), without requiring the caller's wallet scope: recurring
 * writes that sign nothing succeed on any project wallet (HOO-2099). A
 * refused wallet outside the scope is refused as out of scope instead, so a
 * key never learns the purpose of a wallet it cannot see. The custody signer
 * makes the same purpose refusal ({@link decideWalletPurpose}) on every path,
 * cron included.
 *
 * @param caller - The authenticated caller, as read at authentication.
 * @param wallet - The custody wallet the movement would sign with.
 * @param wallet.id - Its custody wallet row id.
 * @param wallet.purpose - Its purpose; null for a wallet created before purposes.
 * @param movement - The movement the wallet would sign.
 */
export function assertWalletPurposeAdmitted(
  caller: Pick<ApiKeyContext, "walletAccess" | "organizationId" | "projectId">,
  wallet: { id: string; purpose: CustodyWalletPurpose | null },
  movement: MovementId
): void {
  if (movementAllowsWalletPurpose(movement, wallet.purpose)) return;
  assertCallerWalletInScope(caller, wallet.id);
  logMoneyRefusedEarly(caller, wallet.id, "wallet_purpose", movement);
  throw new MoneyMovementRefusedError("wallet_purpose");
}

/**
 * The waist's `sdp_money_refused` event for a refusal made before any
 * movement starts (surface `early`). A scope refusal names no movement.
 */
function logMoneyRefusedEarly(
  caller: Pick<ApiKeyContext, "organizationId" | "projectId">,
  custodyWalletId: string,
  reason: Extract<MoneyAdmissionRefusal, "wallet_out_of_scope" | "wallet_purpose">,
  movement: MovementId | null
): void {
  const principal = currentMoneyPrincipal();
  logEvent("warn", {
    event: "sdp_money_refused",
    surface: "early",
    movement,
    module: movement === null ? null : MOVEMENTS[movement].module,
    subject_id: custodyWalletId,
    organization_id: caller.organizationId,
    project_id: caller.projectId,
    principal_kind: principal ? principal.kind : null,
    principal: principal ? describeMoneyPrincipal(principal) : null,
    reason,
  });
}

/**
 * Pure. The organization half of a start's decision. Settings are parsed only
 * for a production project of an active organization, and a value that does
 * not parse throws (fail closed, as at the edge).
 */
export function decideMoneyStart(facts: OrganizationAdmissionFacts | null): MoneyAdmissionDecision {
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

const ADMITTED: MoneyAdmissionDecision = { admitted: true };

function refuse(reason: Exclude<MoneyAdmissionRefusal, "action_not_held">): MoneyAdmissionDecision {
  return { admitted: false, reason };
}

/** A principal holding none of the movement's actions; names the first. */
function refuseActionNotHeld(actions: readonly [Action, ...Action[]]): MoneyAdmissionDecision {
  return { admitted: false, reason: "action_not_held", action: actions[0] };
}

function statusAdmits(
  table: Readonly<Partial<Record<MovementId, readonly string[]>>>,
  movement: MovementId,
  status: string
): boolean {
  return (table[movement] ?? []).some((allowed) => allowed === status);
}

/**
 * Pure. The principal's half of a decision: is the principal live, may it sign
 * with this wallet, and, for a start, does it hold one of the movement's
 * actions. An exit is decided by the credential alone (HOO-2099): no action
 * (the route required one) and no mandate or request status, and with no
 * principal at all (a reconciler finishing a payout) it signs.
 */
export function decidePrincipal(
  movement: MovementId,
  facts: Pick<MoneyAdmissionFacts, "principal" | "readAt">,
  subject: MoneyAdmissionSubject
): MoneyAdmissionDecision {
  // An exit's actions are null: the route already required one.
  const actions = movementActions(movement);
  const principal = facts.principal;
  switch (principal.kind) {
    case "none":
      return actions === null ? ADMITTED : refuse("principal_missing");
    case "api_key":
      return decideApiKey(principal.key, facts.readAt, actions, subject);
    case "member":
      return decideMember(principal.member, actions);
    case "mandate": {
      const mandate = principal.mandate;
      if (
        !mandate ||
        !mayActInStatus(MANDATE_MOVEMENT_STATUSES, movement, actions, mandate.status)
      ) {
        return refuse("principal_not_live");
      }
      const otherWallet =
        subject.custodyWalletId !== null &&
        subject.custodyWalletId !== mandate.sourceCustodyWalletId;
      return otherWallet ? refuse("wallet_out_of_scope") : ADMITTED;
    }
    case "payment_request": {
      const request = principal.request;
      if (
        !request ||
        !mayActInStatus(PAYMENT_REQUEST_MOVEMENT_STATUSES, movement, actions, request.status) ||
        (actions !== null &&
          request.expiresAt !== null &&
          Date.parse(request.expiresAt) <= facts.readAt)
      ) {
        return refuse("principal_not_live");
      }
      // A `/pay` link holds no custody signer; it only ever has SDP sponsor.
      return subject.custodyWalletId === null ? ADMITTED : refuse("wallet_out_of_scope");
    }
    default: {
      const exhaustive: never = principal;
      throw new Error(`Unknown principal facts: ${JSON.stringify(exhaustive)}`);
    }
  }
}

type ApiKeyPrincipalFacts = Extract<MoneyPrincipalFacts, { kind: "api_key" }>["key"];

function decideApiKey(
  key: ApiKeyPrincipalFacts,
  readAt: number,
  actions: readonly [Action, ...Action[]] | null,
  subject: MoneyAdmissionSubject
): MoneyAdmissionDecision {
  if (!key || apiKeyRowRefusal(key, readAt) !== null) {
    return refuse("principal_not_live");
  }
  if (actions !== null && !actions.some((action) => apiKeyMayPerform(key.grants, action))) {
    return refuseActionNotHeld(actions);
  }
  // A selected key signs only with a listed wallet; with none listed it signs
  // nothing. A sponsor names the custody wallet it pays for; one that pays for
  // none (null) has none to scope.
  if (subject.custodyWalletId !== null && key.walletScope === "selected" && !key.walletListed) {
    return refuse("wallet_out_of_scope");
  }
  return ADMITTED;
}

function decideMember(
  member: Extract<MoneyPrincipalFacts, { kind: "member" }>["member"],
  actions: readonly [Action, ...Action[]] | null
): MoneyAdmissionDecision {
  if (!member || !memberStatusMayMoveMoney(member.status)) {
    return refuse("principal_not_live");
  }
  if (actions === null) {
    return ADMITTED;
  }
  // A start needs the project membership the request's project scope was
  // admitted by (`findMemberProject`): removed from the project since, the
  // member starts nothing there. No role bypasses it, as at ingress.
  if (!member.inProject) {
    return refuse("principal_not_live");
  }
  const role = normalizeOrganizationRole(member.role);
  return actions.some((action) => organizationRoleMayPerform(role, action))
    ? ADMITTED
    : refuseActionNotHeld(actions);
}

/** A start needs the row in a status that admits it; an exit only needs the row. */
function mayActInStatus(
  table: Parameters<typeof statusAdmits>[0],
  movement: MovementId,
  actions: readonly Action[] | null,
  status: string
): boolean {
  return actions === null || statusAdmits(table, movement, status);
}

/**
 * Pure. What a signing waist decides for one movement. A start needs the
 * organization ({@link decideMoneyStart}) and then the principal
 * ({@link decidePrincipal}). An exit never needs the organization, so a
 * suspended or unentitled one can always unwind (ADR 0002, ADR 0007); it
 * needs only the credential asking for it, when there is one. `null` facts
 * for an exit mean nothing was read because no principal was set.
 */
export function decideMovement(
  movement: MovementId,
  facts: MoneyAdmissionFacts | null,
  subject: MoneyAdmissionSubject
): MoneyAdmissionDecision {
  if (MOVEMENTS[movement].kind === "exit") {
    return facts ? decidePrincipal(movement, facts, subject) : ADMITTED;
  }
  const organization = decideMoneyStart(facts);
  if (!organization.admitted || !facts) {
    return organization;
  }
  return decidePrincipal(movement, facts, subject);
}

/**
 * Pure. Whether a custody wallet of this purpose may sign the movement
 * (APE-371): the signer's half of {@link assertCallerMaySignWith}.
 *
 * @param movement - The movement asking to sign.
 * @param purpose - The signing wallet's purpose; null for a wallet created before purposes.
 * @returns Admitted, or refused with `wallet_purpose`.
 */
export function decideWalletPurpose(
  movement: MovementId,
  purpose: CustodyWalletPurpose | null
): MoneyAdmissionDecision {
  return movementAllowsWalletPurpose(movement, purpose)
    ? ADMITTED
    : { admitted: false, reason: "wallet_purpose" };
}

/** Where a movement was refused, for the `sdp_money_refused` event. */
export interface MovementRefusalContext {
  surface: "signer" | "sponsor" | MoneyStartContext["surface"];
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
  logMoneyRefused(decision.reason, context);
  throw MoneyMovementRefusedError.of(decision);
}

/** The one `sdp_money_refused` event shape, whichever surface refused. */
function logMoneyRefused(reason: MoneyAdmissionRefusal, context: MovementRefusalContext): void {
  const principal = currentMoneyPrincipal();
  logEvent("warn", {
    event: "sdp_money_refused",
    surface: context.surface,
    movement: context.movement,
    module: MOVEMENTS[context.movement].module,
    subject_id: context.subjectId,
    organization_id: context.organizationId,
    project_id: context.projectId,
    principal_kind: principal ? principal.kind : null,
    principal: principal ? describeMoneyPrincipal(principal) : null,
    reason,
  });
}

const walletScopeSchema = z.enum(API_KEY_WALLET_SCOPES);

interface MoneyAdmissionRow {
  environment: ProjectEnvironment;
  status: string;
  settings: string | null;
  key_id: string | null;
  key_status: ApiKeyLifecycleColumns["status"] | null;
  key_expires_at: string | null;
  key_rotation_deadline: string | null;
  key_grants: unknown;
  key_wallet_scope: string | null;
  key_wallet_listed: boolean | null;
  member_status: string | null;
  member_role: string | null;
  member_in_project: boolean;
  mandate_status: string | null;
  mandate_wallet_id: string | null;
  request_status: string | null;
  request_expires_at: string | null;
}

function principalIdOf(principal: MoneyPrincipal | null, kind: MoneyPrincipalKind): string | null {
  if (!principal || principal.kind !== kind) {
    return null;
  }
  switch (principal.kind) {
    case "api_key":
      return principal.apiKeyId;
    case "member":
      return principal.userId;
    case "mandate":
      return principal.recurringPaymentId;
    case "payment_request":
      return principal.paymentRequestId;
    default: {
      const exhaustive: never = principal;
      throw new Error(`Unknown money principal: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function principalFacts(
  principal: MoneyPrincipal | null,
  row: MoneyAdmissionRow
): MoneyPrincipalFacts {
  if (!principal) {
    return { kind: "none" };
  }
  switch (principal.kind) {
    case "api_key":
      return {
        kind: "api_key",
        key:
          row.key_id === null || row.key_status === null
            ? null
            : {
                status: row.key_status,
                expires_at: row.key_expires_at,
                rotation_deadline: row.key_rotation_deadline,
                grants: parseGrantsColumn(row.key_grants),
                walletScope: walletScopeSchema.parse(row.key_wallet_scope),
                walletListed: row.key_wallet_listed,
              },
      };
    case "member":
      return {
        kind: "member",
        member:
          row.member_status === null || row.member_role === null
            ? null
            : {
                status: row.member_status,
                role: row.member_role,
                inProject: row.member_in_project,
              },
      };
    case "mandate":
      return {
        kind: "mandate",
        mandate:
          row.mandate_status === null
            ? null
            : { status: row.mandate_status, sourceCustodyWalletId: row.mandate_wallet_id },
      };
    case "payment_request":
      return {
        kind: "payment_request",
        request:
          row.request_status === null
            ? null
            : { status: row.request_status, expiresAt: row.request_expires_at },
      };
    default: {
      const exhaustive: never = principal;
      throw new Error(`Unknown money principal: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Whether deciding `movement` needs the admission read. An exit with no
 * ambient principal needs nothing: {@link decideMovement} admits it on `null`.
 */
export function movementNeedsAdmissionFacts(movement: MovementId): boolean {
  return MOVEMENTS[movement].kind === "start" || currentMoneyPrincipal() !== null;
}

/** {@link readMoneyAdmissionFactsWith}, or `null` when the movement needs no read. */
export async function readMovementFactsWith(
  db: DatabaseExecutor,
  scope: MoneyAdmissionScope,
  movement: MovementId,
  subject: MoneyAdmissionSubject
): Promise<MoneyAdmissionFacts | null> {
  return movementNeedsAdmissionFacts(movement)
    ? readMoneyAdmissionFactsWith(db, scope, subject)
    : null;
}

/** {@link readMoneyAdmissionFactsWith} on the request's own client. */
export async function readMoneyAdmissionFacts(
  env: Env,
  scope: MoneyAdmissionScope,
  subject: MoneyAdmissionSubject
): Promise<MoneyAdmissionFacts | null> {
  return readMoneyAdmissionFactsWith(getDb(env), scope, subject);
}

/**
 * One statement, by primary keys, scoped by both ids: the project and its
 * organization, and the ambient principal's row (its key, membership,
 * recurring payment or payment request) in the same project. For a key it
 * also answers whether the subject's custody wallet is in its signing list;
 * for a member, whether they still belong to the project.
 * The joins the principal does not use match nothing, so the cost is the
 * same one round trip the organization read always made.
 */
async function readMoneyAdmissionFactsWith(
  db: DatabaseExecutor,
  scope: MoneyAdmissionScope,
  subject: MoneyAdmissionSubject
): Promise<MoneyAdmissionFacts | null> {
  const principal = currentMoneyPrincipal();
  const row = await db
    .prepare(
      `SELECT p.environment, o.status, o.settings,
              ak.id AS key_id, ak.status AS key_status, ak.expires_at AS key_expires_at,
              ak.rotation_deadline AS key_rotation_deadline, ak.grants AS key_grants,
              ak.wallet_scope AS key_wallet_scope,
              CASE WHEN ak.id IS NULL OR ?::text IS NULL THEN NULL
                   ELSE EXISTS (
                     SELECT 1 FROM api_key_signing_wallets s
                      WHERE s.api_key_id = ak.id AND s.custody_wallet_id = ?::text
                        AND s.status = 'active'
                   )
              END AS key_wallet_listed,
              om.status AS member_status, om.role AS member_role,
              pm.id IS NOT NULL AS member_in_project,
              rp.status AS mandate_status, rp.source_custody_wallet_id AS mandate_wallet_id,
              pr.status AS request_status, pr.expires_at AS request_expires_at
         FROM projects p
         JOIN organizations o ON o.id = p.organization_id
         LEFT JOIN api_keys ak
           ON ak.id = ?::text AND ak.organization_id = p.organization_id AND ak.project_id = p.id
         LEFT JOIN organization_members om
           ON om.user_id = ?::text AND om.organization_id = p.organization_id
         LEFT JOIN project_members pm
           ON pm.user_id = om.user_id AND pm.project_id = p.id
         LEFT JOIN payment_recurring_payments rp
           ON rp.id = ?::text AND rp.organization_id = p.organization_id AND rp.project_id = p.id
         LEFT JOIN payment_requests pr
           ON pr.id = ?::text AND pr.organization_id = p.organization_id AND pr.project_id = p.id
        WHERE p.id = ? AND p.organization_id = ?`
    )
    .bind(
      subject.custodyWalletId,
      subject.custodyWalletId,
      principalIdOf(principal, "api_key"),
      principalIdOf(principal, "member"),
      principalIdOf(principal, "mandate"),
      principalIdOf(principal, "payment_request"),
      scope.projectId,
      scope.organizationId
    )
    .first<MoneyAdmissionRow>();
  return row
    ? {
        organizationStatus: row.status,
        projectEnvironment: row.environment,
        rawSettings: row.settings,
        principal: principalFacts(principal, row),
        readAt: Date.now(),
      }
    : null;
}

/** Reads and decides. Every refusal emits one `sdp_money_refused` event. */
export async function checkMoneyStart(
  env: Env,
  scope: MoneyAdmissionScope,
  context: MoneyStartContext,
  subject: MoneyAdmissionSubject
): Promise<MoneyAdmissionDecision> {
  const decision = decideMovement(
    context.movement,
    await readMovementFactsWith(getDb(env), scope, context.movement, subject),
    subject
  );
  if (!decision.admitted) {
    logMoneyRefused(decision.reason, { ...context, ...scope });
  }
  return decision;
}

/** {@link checkMoneyStart}, throwing {@link MoneyMovementRefusedError} (403) on refusal. */
export async function assertMoneyStartAdmitted(
  env: Env,
  scope: MoneyAdmissionScope,
  context: MoneyStartContext,
  subject: MoneyAdmissionSubject
): Promise<void> {
  const decision = await checkMoneyStart(env, scope, context, subject);
  if (!decision.admitted) {
    throw MoneyMovementRefusedError.of(decision);
  }
}
