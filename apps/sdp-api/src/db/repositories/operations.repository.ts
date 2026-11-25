import { randomUUID } from "node:crypto";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  isTerminalOperationStatus,
  OPERATION_STATUSES,
  OPERATION_TRANSITIONS,
  type Operation,
  type OperationIntent,
  type OperationNextAction,
  type OperationProposalBinding,
  type OperationReference,
  type OperationSource,
  type OperationStatus,
  type OperationStatusFilter,
  type OperationTerms,
  operationIntentSchema,
  operationNextActionSchema,
  operationProposalBindingSchema,
  operationReferenceSchema,
  operationSchema,
  operationSourceSchema,
  operationTermsSchema,
  operationTransitionRequiresResourceReference,
  SDP_PROGRESS_OPERATION_STATUSES,
  TERMINAL_OPERATION_STATUSES,
} from "@sdp/types/operations";
import { z } from "zod";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";
import { OPERATION_WAKE_CHANNEL } from "@/db/operation-notifications";
import { sqlLiteralList } from "@/db/postgres-utils";
import {
  acceptCurrentRedemptionReleaseWithin,
  releaseCurrentRedemptionReleaseWithin,
} from "@/db/repositories/earn-redemption-release.repository";
import { conflict, internalError, notFound } from "@/lib/errors";
import { type MoneyPrincipal, moneyPrincipalSchema } from "@/lib/money-principal";
import { OPERATION_WORKER_LEASE_MS } from "@/services/earn/operation-worker-budget";

/** Every operation access carries exact tenant, project and cluster scope. */
export interface OperationScope {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
}

/** Address-filtered history names one owner; wallet history names known project wallets. */
export interface OperationListFilters {
  kind?: Operation["kind"];
  status?: OperationStatusFilter;
  ownerAddress?: string;
  walletId?: string;
  positionId?: string;
  operationIds?: readonly string[];
  allowedWalletIds?: readonly string[];
}

/** The current version's execution record; signed bytes and account binding are first-write-wins. */
export interface OperationAttempt {
  id: string;
  operationId: string;
  actionId: string;
  version: number;
  principal: MoneyPrincipal;
  buildRef: OperationReference | null;
  signedTransaction: string | null;
  signature: string | null;
  lastValidBlockHeight: string | null;
  dispatchStartedAt: string | null;
  executionRequestedAt: string | null;
  /** Audit admission is linked atomically with this action's queue request. */
  auditIntentId: string | null;
  observationOnly: boolean;
  proposalBinding: OperationProposalBinding | null;
  resourceRef: OperationReference | null;
}

/** Exact bytes already verified against the stored unsigned action. */
export interface OperationSignedAttempt {
  signedTransaction: string;
  signature: string;
  lastValidBlockHeight: string;
}

/** Internal identity and concurrency state never cross the public response boundary. */
export interface OperationRecord {
  operation: Operation;
  source: OperationSource;
  scope: OperationScope;
  principal: MoneyPrincipal;
  requestKey: string;
  fingerprint: string;
  claimToken: string | null;
  claimUntil: string | null;
  fence: number;
  actionPurpose: "execute" | "cancel";
  actionPrincipal: MoneyPrincipal;
}

/** A claim permits work only while the matching fence still owns its lease. */
export interface OperationClaim {
  operation: Operation;
  attempt: OperationAttempt;
  token: string;
  fence: number;
  /** Once dispatch may have started, a takeover may observe/retry exact bytes only. */
  recoveryRequired: boolean;
  purpose: "execute" | "cancel";
  /** True only for the durable first recovery claim of this accepted attempt. */
  firstExecutionClaim?: boolean;
}

/** A validated, side-effect-free action ready for display. */
export interface PreparedOperationAction {
  nextAction: OperationNextAction;
  terms: OperationTerms;
  buildRef: OperationReference | null;
}

/** First-write-wins request input; preparation never initiates signing. */
export interface CreateOperationInput extends OperationScope {
  intent: OperationIntent;
  source: OperationSource;
  principal: MoneyPrincipal;
  requestKey: string;
  fingerprint: string;
  prepared: PreparedOperationAction;
}

/** Authoritative domain evidence is required for terminal settlement projections. */
export interface OperationUpdate {
  status: OperationStatus;
  nextAction: OperationNextAction | null;
  resourceRef: OperationReference | null;
  error: Operation["error"];
}

/** The domain reconciler, never an API body, supplies resolved-attempt evidence. */
export type OperationReplacementEvidence =
  | { kind: "never_dispatched" }
  | { kind: "resolved_attempt"; resourceRef: OperationReference };

const rowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  kind: z.enum(["earn.deposit", "earn.withdraw"]),
  status: z.enum(OPERATION_STATUSES),
  intent: operationIntentSchema,
  source: operationSourceSchema,
  principal: moneyPrincipalSchema,
  action_principal: moneyPrincipalSchema,
  request_key: z.string(),
  fingerprint: z.string(),
  action_id: z.string(),
  action_version: z.number(),
  action_purpose: z.enum(["execute", "cancel"]),
  next_action: operationNextActionSchema.nullable(),
  terms: operationTermsSchema,
  build_ref: operationReferenceSchema.nullable(),
  resource_ref: operationReferenceSchema.nullable(),
  error: operationSchema.shape.error,
  cancel_requested_at: z.string().nullable(),
  claim_token: z.string().nullable(),
  claim_until: z.string().nullable(),
  fence: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  has_submitted: z.boolean(),
});
const attemptRowSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  action_id: z.string(),
  action_version: z.number(),
  principal: moneyPrincipalSchema,
  build_ref: operationReferenceSchema.nullable(),
  signed_transaction: z.string().nullable(),
  signature: z.string().nullable(),
  last_valid_block_height: z.string().nullable(),
  dispatch_started_at: z.string().nullable(),
  execution_requested_at: z.string().nullable(),
  audit_intent_id: z.string().nullable(),
  observation_only: z.boolean(),
  proposal_binding: operationProposalBindingSchema.nullable(),
  resource_ref: operationReferenceSchema.nullable(),
});
const OPERATION_COLUMNS = `*,
  CASE WHEN claim_until IS NULL THEN NULL ELSE to_char(claim_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS claim_until,
  EXISTS (SELECT 1 FROM operation_attempts attempt
    WHERE attempt.operation_id = operations.id
      AND attempt.organization_id = operations.organization_id
      AND attempt.project_id = operations.project_id
      AND attempt.environment = operations.environment
      AND attempt.execution_requested_at IS NOT NULL) AS has_submitted`;
const scopeSql = "organization_id = ? AND project_id = ? AND environment = ?";
const scopeValues = (scope: OperationScope) => [
  scope.organizationId,
  scope.projectId,
  scope.environment,
];

function parseRecord(value: unknown): OperationRecord {
  const row = rowSchema.parse(value);
  const operation = operationSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    environment: row.environment,
    intent: row.intent,
    actionId: row.action_id,
    version: row.action_version,
    nextAction: row.next_action,
    terms: row.terms,
    buildRef: row.build_ref,
    resourceRef: row.resource_ref,
    canCancel:
      row.status === "prepared" &&
      row.action_purpose === "execute" &&
      row.resource_ref === null &&
      !row.has_submitted &&
      (row.claim_until === null || Date.parse(row.claim_until) <= Date.now()) &&
      (("walletId" in row.source && row.next_action?.type === "submit") ||
        (row.next_action?.type === "select_option" &&
          row.build_ref?.kind === "earn.withdrawal_options")),
    error: row.error,
    result: null,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return {
    operation,
    source: row.source,
    scope: {
      organizationId: row.organization_id,
      projectId: row.project_id,
      environment: row.environment,
    },
    principal: row.principal,
    requestKey: row.request_key,
    fingerprint: row.fingerprint,
    claimToken: row.claim_token,
    claimUntil: row.claim_until,
    fence: row.fence,
    actionPurpose: row.action_purpose,
    actionPrincipal: row.action_principal,
  };
}
function parseAttempt(value: unknown): OperationAttempt {
  const row = attemptRowSchema.parse(value);
  return {
    id: row.id,
    operationId: row.operation_id,
    actionId: row.action_id,
    version: row.action_version,
    principal: row.principal,
    buildRef: row.build_ref,
    signedTransaction: row.signed_transaction,
    signature: row.signature,
    lastValidBlockHeight: row.last_valid_block_height,
    dispatchStartedAt: row.dispatch_started_at,
    executionRequestedAt: row.execution_requested_at,
    auditIntentId: row.audit_intent_id,
    observationOnly: row.observation_only,
    proposalBinding: row.proposal_binding,
    resourceRef: row.resource_ref,
  };
}
function assertCurrentAction(
  operation: Operation,
  action: { actionId: string; version: number }
): void {
  if (operation.actionId !== action.actionId || operation.version !== action.version)
    throw conflict("Operation action or terms version changed", {
      reason: "stale_operation_action",
    });
}
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqlJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function assertReplacementEvidence(
  attempt: OperationAttempt | null,
  evidence: OperationReplacementEvidence
): void {
  const needsEvidence =
    attempt !== null && (attempt.dispatchStartedAt !== null || attempt.signedTransaction !== null);
  if (needsEvidence && evidence.kind !== "resolved_attempt")
    throw conflict("Operation attempt must be reconciled before refreshing");
  if (evidence.kind !== "resolved_attempt") return;
  const reference = operationReferenceSchema.parse(evidence.resourceRef);
  if (attempt === null || attempt.resourceRef === null || !sameJson(attempt.resourceRef, reference))
    throw conflict("Refresh evidence does not match the recorded attempt");
}

/** SQL coordination for operations; provider and RPC calls never run in its transactions. */
export function createOperationsRepository(db: DatabaseClient) {
  async function read(tx: DatabaseExecutor, scope: OperationScope, id: string, lock: boolean) {
    const row = await tx.queryOne(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE id = ? AND ${scopeSql}${lock ? " FOR UPDATE" : ""}`,
      [id, ...scopeValues(scope)]
    );
    return row === null ? null : parseRecord(row);
  }
  async function requireRecord(
    tx: DatabaseExecutor,
    scope: OperationScope,
    id: string,
    lock: boolean
  ) {
    const row = await read(tx, scope, id, lock);
    if (row === null) throw notFound("Operation");
    return row;
  }
  async function requireClaim(tx: DatabaseExecutor, scope: OperationScope, claim: OperationClaim) {
    const row = await requireRecord(tx, scope, claim.operation.id, true);
    assertCurrentAction(row.operation, claim.operation);
    if (
      row.claimToken !== claim.token ||
      row.fence !== claim.fence ||
      row.claimUntil === null ||
      Date.parse(row.claimUntil) <= Date.now()
    )
      throw conflict("Operation execution lease changed", { reason: "stale_operation_claim" });
    return row;
  }
  async function currentAttempt(tx: DatabaseExecutor, scope: OperationScope, operation: Operation) {
    const row = await tx.queryOne(
      `SELECT * FROM operation_attempts WHERE operation_id = ? AND action_id = ? AND action_version = ? AND ${scopeSql}`,
      [operation.id, operation.actionId, operation.version, ...scopeValues(scope)]
    );
    return row === null ? null : parseAttempt(row);
  }
  async function assertUnsubmitted(
    tx: DatabaseExecutor,
    scope: OperationScope,
    row: OperationRecord
  ): Promise<void> {
    // Read after the lock so a preceding acceptance is visible even when our
    // lock statement began before that acceptance committed.
    const accepted = await tx.queryOne(
      `SELECT 1 FROM operation_attempts WHERE operation_id = ? AND ${scopeSql}
         AND execution_requested_at IS NOT NULL LIMIT 1`,
      [row.operation.id, ...scopeValues(scope)]
    );
    if (accepted !== null)
      throw conflict("Submitted operations cannot be changed; keep tracking the outcome", {
        reason: "operation_already_submitted",
      });
    if (row.claimUntil !== null && Date.parse(row.claimUntil) > Date.now())
      throw conflict("Operation submission is in progress", { reason: "operation_in_progress" });
  }
  async function wakeRecovery(
    tx: DatabaseExecutor,
    scope: OperationScope,
    id: string
  ): Promise<void> {
    await tx.execute(
      `UPDATE operations SET next_check_at = COALESCE(next_check_at, now()) WHERE id = ? AND ${scopeSql}`,
      [id, ...scopeValues(scope)]
    );
  }
  async function writeSignedAttempt(
    tx: DatabaseExecutor,
    scope: OperationScope,
    attempt: OperationAttempt,
    signed: OperationSignedAttempt
  ): Promise<OperationAttempt> {
    if (attempt.signedTransaction !== null) {
      if (
        attempt.signedTransaction !== signed.signedTransaction ||
        attempt.signature !== signed.signature ||
        attempt.lastValidBlockHeight !== signed.lastValidBlockHeight
      )
        throw conflict("Operation attempt already has different signed bytes");
      return attempt;
    }
    const updated = await tx.queryOne(
      `UPDATE operation_attempts SET signed_transaction = ?, signature = ?, last_valid_block_height = ?
       WHERE id = ? AND ${scopeSql} RETURNING *`,
      [
        signed.signedTransaction,
        signed.signature,
        signed.lastValidBlockHeight,
        attempt.id,
        ...scopeValues(scope),
      ]
    );
    await wakeRecovery(tx, scope, attempt.operationId);
    return parseAttempt(updated);
  }
  async function leaseRecovery(
    tx: DatabaseExecutor,
    row: OperationRecord
  ): Promise<OperationClaim | null> {
    if (isTerminalOperationStatus(row.operation.status)) return null;
    const { scope } = row;
    const attempt = await currentAttempt(tx, scope, row.operation);
    if (
      attempt === null ||
      (attempt.executionRequestedAt === null &&
        attempt.dispatchStartedAt === null &&
        attempt.signedTransaction === null)
    )
      return null;
    const token = randomUUID();
    const changed = await tx.queryOne(
      `WITH leased AS (
        UPDATE operations SET claim_token = ?, claim_until = now() + (? * interval '1 second'), fence = fence + 1
        WHERE id = ? AND ${scopeSql} AND next_check_at <= now()
          AND (claim_until IS NULL OR claim_until <= now()) RETURNING ${OPERATION_COLUMNS}
      ), first_pickup AS (
        UPDATE operation_attempts SET first_execution_claimed_at = sdp_iso_now()
        WHERE id = ? AND operation_id IN (SELECT id FROM leased)
          AND first_execution_claimed_at IS NULL RETURNING id
      ) SELECT leased.*, EXISTS (SELECT 1 FROM first_pickup) AS first_execution_claim FROM leased`,
      [token, OPERATION_WORKER_LEASE_MS / 1000, row.operation.id, ...scopeValues(scope), attempt.id]
    );
    if (changed === null) return null;
    const current = parseRecord(changed);
    return {
      operation: current.operation,
      attempt,
      token,
      fence: current.fence,
      firstExecutionClaim: changed.first_execution_claim === true,
      purpose: current.actionPurpose,
      recoveryRequired:
        attempt.dispatchStartedAt !== null ||
        attempt.resourceRef !== null ||
        attempt.observationOnly ||
        (current.operation.cancelRequestedAt !== null && current.actionPurpose === "execute"),
    };
  }
  return {
    get: (scope: OperationScope, id: string) => read(db, scope, id, false),

    /** The exact current action's attempt, without claiming or starting execution. */
    async getCurrentAttempt(scope: OperationScope, id: string): Promise<OperationAttempt | null> {
      const row = await requireRecord(db, scope, id, false);
      return currentAttempt(db, scope, row.operation);
    },

    async findByRequest(scope: OperationScope, kind: Operation["kind"], requestKey: string) {
      const row = await db.queryOne(
        `SELECT ${OPERATION_COLUMNS} FROM operations WHERE ${scopeSql} AND kind = ? AND request_key = ?`,
        [...scopeValues(scope), kind, requestKey]
      );
      return row === null ? null : parseRecord(row);
    },

    async createOrReplay(
      input: CreateOperationInput
    ): Promise<{ record: OperationRecord; replayed: boolean }> {
      const intent = operationIntentSchema.parse(input.intent);
      const source = operationSourceSchema.parse(input.source);
      if (intent.kind === "earn.deposit" && !sameJson(source, intent.source))
        throw conflict("Deposit source does not match its authorized operation source");
      const principal = moneyPrincipalSchema.parse(input.principal);
      const nextAction = operationNextActionSchema.parse(input.prepared.nextAction);
      const terms = operationTermsSchema.parse(input.prepared.terms);
      const buildRef = operationReferenceSchema.nullable().parse(input.prepared.buildRef);
      return db.transaction(async (tx) => {
        const row = await tx.queryOne(
          `INSERT INTO operations (id, organization_id, project_id, environment, kind, status,
             intent, source, principal, action_principal, request_key, fingerprint, action_id, next_action, terms, build_ref)
           VALUES (?, ?, ?, ?, ?, 'prepared', ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)
           ON CONFLICT ON CONSTRAINT operations_request_unique DO NOTHING RETURNING ${OPERATION_COLUMNS}`,
          [
            `op_${randomUUID()}`,
            ...scopeValues(input),
            intent.kind,
            JSON.stringify(intent),
            JSON.stringify(source),
            JSON.stringify(principal),
            JSON.stringify(principal),
            input.requestKey,
            input.fingerprint,
            `opa_${randomUUID()}`,
            JSON.stringify(nextAction),
            JSON.stringify(terms),
            sqlJson(buildRef),
          ]
        );
        if (row !== null) return { record: parseRecord(row), replayed: false };
        const prior = await tx.queryOne(
          `SELECT ${OPERATION_COLUMNS} FROM operations WHERE ${scopeSql} AND kind = ? AND request_key = ?`,
          [...scopeValues(input), intent.kind, input.requestKey]
        );
        if (prior === null) throw internalError("Operation request disappeared during replay");
        const record = parseRecord(prior);
        if (
          record.fingerprint !== input.fingerprint ||
          !sameJson(record.principal, principal) ||
          !sameJson(record.source, source)
        )
          throw conflict("Idempotency key already used with different operation input");
        return { record, replayed: true };
      });
    },

    async list(
      scope: OperationScope,
      input: OperationListFilters & {
        limit: number;
        before: { createdAt: string; id: string } | null;
      }
    ) {
      const filters = [scopeSql];
      const values: unknown[] = scopeValues(scope);
      if (input.operationIds !== undefined) {
        filters.push("id = ANY(?::text[])");
        values.push(input.operationIds);
      }
      if (input.kind !== undefined) {
        filters.push("kind = ?");
        values.push(input.kind);
      }
      if (input.status === "active") {
        filters.push(`status NOT IN (${sqlLiteralList(TERMINAL_OPERATION_STATUSES)})`);
      } else if (input.status !== undefined) {
        filters.push("status = ?");
        values.push(input.status);
      }
      const wallet = "source ->> 'walletId'";
      if (input.ownerAddress !== undefined) {
        // Match owner-address history: one explicitly addressed owner,
        // exact project, and a proven address source. Never list an address book.
        const owner = "source ->> 'ownerAddress'";
        filters.push(`(${wallet} IS NULL AND ${owner} = ?)`);
        values.push(input.ownerAddress);
      } else {
        // The authorized immutable source survives option selection and every continuation.
        filters.push(`${wallet} IS NOT NULL`);
        if (input.allowedWalletIds !== undefined) {
          filters.push(`${wallet} = ANY(?::text[])`);
          values.push(input.allowedWalletIds);
        }
      }
      if (input.walletId !== undefined) {
        filters.push(`${wallet} = ?`);
        values.push(input.walletId);
      }
      if (input.positionId !== undefined) {
        const scopedReference = (alias: string, reference: "build_ref" | "resource_ref") =>
          `${alias}.id = operations.${reference} ->> 'id'
            AND ${alias}.organization_id = operations.organization_id
            AND ${alias}.project_id = operations.project_id
            AND ${alias}.environment = operations.environment AND ${alias}.position_id = ?`;
        filters.push(`(intent ->> 'positionId' = ?
          OR EXISTS (SELECT 1 FROM earn_wallet_transactions build
            WHERE operations.build_ref ->> 'kind' = 'earn.strategy_transaction'
              AND ${scopedReference("build", "build_ref")})
          OR EXISTS (SELECT 1 FROM earn_wallet_withdrawal_request_transactions build
            WHERE operations.build_ref ->> 'kind' = 'earn.queued_transaction'
              AND ${scopedReference("build", "build_ref")})
          OR EXISTS (SELECT 1 FROM earn_movements movement
            WHERE operations.resource_ref ->> 'kind' = 'earn.movement'
              AND ${scopedReference("movement", "resource_ref")})
          OR EXISTS (SELECT 1 FROM earn_vault_withdrawal_requests request
            WHERE operations.resource_ref ->> 'kind' = 'earn.withdrawal_request'
              AND ${scopedReference("request", "resource_ref")}))`);
        values.push(...Array.from({ length: 5 }, () => input.positionId));
      }
      if (input.before !== null) {
        filters.push("(created_at, id) < (?, ?)");
        values.push(input.before.createdAt, input.before.id);
      }
      values.push(input.limit);
      const rows = await db.queryMany(
        `SELECT ${OPERATION_COLUMNS} FROM operations WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
        values
      );
      return rows.map(parseRecord);
    },

    async claimAction(
      scope: OperationScope,
      id: string,
      action: { actionId: string; version: number },
      leaseSeconds = 60,
      allowCancelledSignedRecovery = false
    ): Promise<OperationClaim> {
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
        throw new Error("Operation execution lease must be between 1 and 300 seconds");
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        assertCurrentAction(row.operation, action);
        if (isTerminalOperationStatus(row.operation.status))
          throw conflict("Operation is already terminal");
        if (row.claimUntil !== null && Date.parse(row.claimUntil) > Date.now())
          throw conflict("Operation action is already in progress", {
            reason: "operation_in_progress",
          });
        let attempt = await currentAttempt(tx, scope, row.operation);
        const signedCancellationRecovery =
          allowCancelledSignedRecovery && row.operation.nextAction?.type === "sign_transaction";
        if (
          row.operation.cancelRequestedAt !== null &&
          row.actionPurpose === "execute" &&
          attempt?.dispatchStartedAt == null &&
          !signedCancellationRecovery
        )
          throw conflict("Operation cancellation was requested");
        if (attempt === null) {
          if (
            row.operation.nextAction?.type !== "submit" &&
            row.operation.nextAction?.type !== "sign_transaction"
          )
            throw conflict("Operation has no executable action");
          const created = await tx.queryOne(
            `INSERT INTO operation_attempts (id, operation_id, organization_id, project_id, environment, action_id, action_version, build_ref, principal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb) RETURNING *`,
            [
              `opat_${randomUUID()}`,
              id,
              ...scopeValues(scope),
              action.actionId,
              action.version,
              sqlJson(row.operation.buildRef),
              JSON.stringify(row.actionPrincipal),
            ]
          );
          attempt = parseAttempt(created);
        }
        const token = randomUUID();
        const claimed = await tx.queryOne(
          `UPDATE operations SET claim_token = ?, claim_until = now() + make_interval(secs => ?),
             fence = fence + 1 WHERE id = ? AND ${scopeSql} RETURNING ${OPERATION_COLUMNS}`,
          [token, leaseSeconds, id, ...scopeValues(scope)]
        );
        const record = parseRecord(claimed);
        return {
          operation: record.operation,
          attempt,
          token,
          fence: record.fence,
          purpose: record.actionPurpose,
          recoveryRequired:
            attempt.dispatchStartedAt !== null ||
            attempt.resourceRef !== null ||
            (row.operation.cancelRequestedAt !== null && signedCancellationRecovery),
        };
      });
    },

    async getAttempt(scope: OperationScope, id: string): Promise<OperationAttempt | null> {
      const record = await requireRecord(db, scope, id, false);
      return currentAttempt(db, scope, record.operation);
    },

    /** Competing workers skip leased or locked rows and claim only work ready to start. */
    async claimNextRecovery(
      environment: SdpEnvironment
    ): Promise<{ scope: OperationScope; claim: OperationClaim } | null> {
      return db.transaction(async (tx) => {
        const found = await tx.queryOne(
          `SELECT ${OPERATION_COLUMNS} FROM operations
           WHERE environment = ? AND status NOT IN (${sqlLiteralList(TERMINAL_OPERATION_STATUSES)})
             AND next_check_at <= now() AND (claim_until IS NULL OR claim_until <= now())
             AND EXISTS (SELECT 1 FROM operation_attempts attempt
               WHERE attempt.operation_id = operations.id
                 AND attempt.organization_id = operations.organization_id
                 AND attempt.project_id = operations.project_id
                 AND attempt.environment = operations.environment
                 AND attempt.action_id = operations.action_id
                 AND attempt.action_version = operations.action_version
                 AND (attempt.execution_requested_at IS NOT NULL OR attempt.dispatch_started_at IS NOT NULL OR attempt.signed_transaction IS NOT NULL))
           ORDER BY next_check_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [environment]
        );
        if (found === null) return null;
        const row = parseRecord(found);
        const claim = await leaseRecovery(tx, row);
        return claim === null ? null : { scope: row.scope, claim };
      });
    },

    /** Lease a previously requested execution or recover its retained effects; never create an attempt. */
    async claimRecovery(scope: OperationScope, id: string): Promise<OperationClaim | null> {
      return db.transaction(async (tx) =>
        leaseRecovery(tx, await requireRecord(tx, scope, id, true))
      );
    },

    /** Unexposed choices and server-held unsigned builds cannot broadcast independently. */
    async cancelUndispatched(scope: OperationScope, id: string): Promise<Operation | null> {
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        if (isTerminalOperationStatus(row.operation.status)) return row.operation;
        if (row.operation.cancelRequestedAt === null) return null;
        const attempt = await currentAttempt(tx, scope, row.operation);
        const definitelyNotSent =
          attempt !== null &&
          attempt.signedTransaction === null &&
          row.operation.resourceRef?.kind === "custody.proposal_not_sent" &&
          row.operation.resourceRef.id === attempt.id &&
          sameJson(attempt.resourceRef, row.operation.resourceRef);
        const localUnsigned =
          row.actionPurpose === "execute" &&
          ("walletId" in row.source ||
            (row.operation.nextAction?.type === "select_option" &&
              row.operation.buildRef?.kind === "earn.withdrawal_options" &&
              attempt === null)) &&
          row.operation.resourceRef === null &&
          (attempt === null ||
            (attempt.signedTransaction === null && attempt.dispatchStartedAt === null));
        if (!definitelyNotSent && !localUnsigned) return null;
        if (
          !definitelyNotSent &&
          attempt !== null &&
          (attempt.dispatchStartedAt !== null || attempt.signedTransaction !== null)
        )
          return null;
        const reference = definitelyNotSent
          ? row.operation.resourceRef
          : { kind: "operation.preparation", id: row.operation.buildRef?.id ?? id };
        const changed = await tx.queryOne(
          `UPDATE operations SET status = 'cancelled', next_action = NULL, cancel_requested_at = COALESCE(cancel_requested_at, sdp_iso_now()),
           resource_ref = ?::jsonb, claim_token = NULL, claim_until = NULL, updated_at = sdp_iso_now()
           WHERE id = ? AND ${scopeSql} RETURNING ${OPERATION_COLUMNS}`,
          [JSON.stringify(reference), id, ...scopeValues(scope)]
        );
        return parseRecord(changed).operation;
      });
    },

    async recordProposalBinding(
      scope: OperationScope,
      claim: OperationClaim,
      input: OperationProposalBinding
    ): Promise<OperationAttempt> {
      const binding = operationProposalBindingSchema.parse(input);
      if (binding.externalId !== claim.attempt.id)
        throw conflict("Proposal external identity must match its durable attempt");
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        const attempt = await currentAttempt(tx, scope, row.operation);
        if (attempt === null) throw internalError("Operation attempt is missing");
        if (attempt.proposalBinding !== null) {
          if (!sameJson(attempt.proposalBinding, binding))
            throw conflict("Operation proposal binding changed");
          return attempt;
        }
        if (attempt.dispatchStartedAt !== null)
          throw conflict("Cannot change a dispatched operation attempt");
        const updated = await tx.queryOne(
          `UPDATE operation_attempts SET proposal_binding = ?::jsonb WHERE id = ? AND ${scopeSql} RETURNING *`,
          [JSON.stringify(binding), attempt.id, ...scopeValues(scope)]
        );
        return parseAttempt(updated);
      });
    },

    async recordSignedAttempt(
      scope: OperationScope,
      claim: OperationClaim,
      signed: { signedTransaction: string; signature: string; lastValidBlockHeight: string }
    ): Promise<OperationAttempt> {
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        const attempt = await currentAttempt(tx, scope, row.operation);
        if (attempt === null) throw internalError("Operation attempt is missing");
        return writeSignedAttempt(tx, scope, attempt, signed);
      });
    },

    /** Link audit admission and queue acceptance in the audit ledger's transaction. */
    async requestExecutionWithin(
      tx: DatabaseExecutor,
      scope: OperationScope,
      claim: OperationClaim,
      auditIntentId: string,
      signed?: OperationSignedAttempt
    ): Promise<boolean> {
      const row = await requireClaim(tx, scope, claim);
      const attempt = await currentAttempt(tx, scope, row.operation);
      if (attempt === null) throw internalError("Operation attempt is missing");
      if (signed !== undefined) await writeSignedAttempt(tx, scope, attempt, signed);
      if (attempt.auditIntentId !== null) return false;
      if (
        row.operation.cancelRequestedAt !== null &&
        row.actionPurpose === "execute" &&
        !attempt.observationOnly
      )
        throw conflict("Operation cancellation was requested");
      await tx.execute(
        `UPDATE operation_attempts SET audit_intent_id = ?,
           execution_requested_at = COALESCE(execution_requested_at, sdp_iso_now())
         WHERE id = ? AND ${scopeSql}`,
        [auditIntentId, attempt.id, ...scopeValues(scope)]
      );
      await acceptCurrentRedemptionReleaseWithin(tx, scope, attempt);
      await wakeRecovery(tx, scope, claim.operation.id);
      return true;
    },

    /** Queue explicit authorization durably; no signing or broadcast happens here. */
    async requestExecution(
      scope: OperationScope,
      claim: OperationClaim,
      signed?: OperationSignedAttempt
    ): Promise<OperationAttempt> {
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        const attempt = await currentAttempt(tx, scope, row.operation);
        if (attempt === null) throw internalError("Operation attempt is missing");
        if (signed !== undefined) await writeSignedAttempt(tx, scope, attempt, signed);
        if (
          row.operation.cancelRequestedAt !== null &&
          row.actionPurpose === "execute" &&
          !attempt.observationOnly
        )
          throw conflict("Operation cancellation was requested");
        const updated = await tx.queryOne(
          `UPDATE operation_attempts SET execution_requested_at = COALESCE(execution_requested_at, sdp_iso_now())
           WHERE id = ? AND ${scopeSql} RETURNING *`,
          [attempt.id, ...scopeValues(scope)]
        );
        await acceptCurrentRedemptionReleaseWithin(tx, scope, attempt);
        await wakeRecovery(tx, scope, claim.operation.id);
        return parseAttempt(updated);
      });
    },

    /** Irreversible across process restarts, including before a first signature observation. */
    async restrictToObservation(
      scope: OperationScope,
      claim: OperationClaim
    ): Promise<OperationAttempt> {
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        const attempt = await currentAttempt(tx, scope, row.operation);
        if (attempt === null) throw internalError("Operation attempt is missing");
        const updated = await tx.queryOne(
          `UPDATE operation_attempts SET observation_only = TRUE WHERE id = ? AND ${scopeSql} RETURNING *`,
          [attempt.id, ...scopeValues(scope)]
        );
        return parseAttempt(updated);
      });
    },

    /** A false result means observe the existing attempt; it never permits another proposal. */
    async markDispatchStarted(scope: OperationScope, claim: OperationClaim): Promise<boolean> {
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        if (row.operation.cancelRequestedAt !== null && row.actionPurpose === "execute")
          throw conflict("Operation cancellation was requested");
        const attempt = await currentAttempt(tx, scope, row.operation);
        if (attempt === null) throw internalError("Operation attempt is missing");
        if (attempt.observationOnly) throw conflict("Operation attempt permits observation only");
        if (attempt.dispatchStartedAt !== null) return false;
        if (attempt.signedTransaction === null && attempt.proposalBinding === null)
          throw conflict("Persist signed bytes or a proposal binding before dispatch");
        await wakeRecovery(tx, scope, claim.operation.id);
        return (
          (await tx.execute(
            `UPDATE operation_attempts SET dispatch_started_at = sdp_iso_now() WHERE id = ? AND ${scopeSql} AND dispatch_started_at IS NULL`,
            [attempt.id, ...scopeValues(scope)]
          )) === 1
        );
      });
    },

    async transition(
      scope: OperationScope,
      claim: OperationClaim,
      update: OperationUpdate
    ): Promise<Operation> {
      return db.transaction(async (tx) => {
        const row = await requireClaim(tx, scope, claim);
        const before = row.operation;
        const legal: readonly string[] = OPERATION_TRANSITIONS[before.status];
        if (before.status !== update.status && !legal.includes(update.status))
          throw conflict("Operation cannot make this status transition");
        if (isTerminalOperationStatus(before.status))
          throw conflict("Terminal operation cannot change");
        if (
          operationTransitionRequiresResourceReference(update.status) &&
          update.resourceRef === null
        )
          throw conflict("Terminal settlement requires an authoritative resource reference");
        if (before.resourceRef !== null && !sameJson(before.resourceRef, update.resourceRef))
          throw conflict("Operation settlement resource changed");
        const nextAction = isTerminalOperationStatus(update.status)
          ? null
          : operationNextActionSchema.nullable().parse(update.nextAction);
        const resourceRef = operationReferenceSchema.nullable().parse(update.resourceRef);
        const error = operationSchema.shape.error.parse(update.error);
        const changed = await tx.queryOne(
          `UPDATE operations SET status = ?, next_action = ?::jsonb, resource_ref = ?::jsonb,
             error = ?::jsonb, updated_at = sdp_iso_now() WHERE id = ? AND ${scopeSql}
             AND status = ? AND claim_token = ? AND fence = ? RETURNING ${OPERATION_COLUMNS}`,
          [
            update.status,
            sqlJson(nextAction),
            sqlJson(resourceRef),
            sqlJson(error),
            before.id,
            ...scopeValues(scope),
            before.status,
            claim.token,
            claim.fence,
          ]
        );
        if (changed === null) throw conflict("Operation changed during transition");
        if (resourceRef !== null)
          await tx.execute(
            `UPDATE operation_attempts SET resource_ref = ?::jsonb WHERE id = ? AND ${scopeSql}`,
            [JSON.stringify(resourceRef), claim.attempt.id, ...scopeValues(scope)]
          );
        if (isTerminalOperationStatus(update.status))
          await releaseCurrentRedemptionReleaseWithin(tx, scope, claim.attempt);
        return parseRecord(changed).operation;
      });
    },

    /** Cancellation records intent; no acknowledgement is projected as a terminal outcome. */
    async requestCancellation(scope: OperationScope, id: string): Promise<Operation> {
      const row = await db.queryOne(
        `UPDATE operations SET cancel_requested_at = COALESCE(cancel_requested_at, sdp_iso_now()),
           updated_at = sdp_iso_now() WHERE id = ? AND ${scopeSql}
           AND status NOT IN (${sqlLiteralList(TERMINAL_OPERATION_STATUSES)}) RETURNING ${OPERATION_COLUMNS}`,
        [id, ...scopeValues(scope)]
      );
      if (row !== null) return parseRecord(row).operation;
      return (await requireRecord(db, scope, id, false)).operation;
    },

    /** The operation lock serializes pre-submit cancellation with durable acceptance. */
    async cancelPreparation(scope: OperationScope, id: string): Promise<Operation> {
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        await assertUnsubmitted(tx, scope, row);
        if (row.operation.status === "cancelled") return row.operation;
        if (row.operation.nextAction?.type === "sign_transaction")
          throw conflict("An exposed wallet transaction cannot be revoked by SDP", {
            reason: "wallet_transaction_outcome_unknown",
          });
        if (!row.operation.canCancel)
          throw conflict("Operation has no cancellable preparation", {
            reason: "operation_not_cancellable",
          });
        const changed = await tx.queryOne(
          `UPDATE operations SET status = 'cancelled', next_action = NULL,
             cancel_requested_at = COALESCE(cancel_requested_at, sdp_iso_now()),
             resource_ref = ?::jsonb, claim_token = NULL, claim_until = NULL,
             updated_at = sdp_iso_now() WHERE id = ? AND ${scopeSql} RETURNING ${OPERATION_COLUMNS}`,
          [
            JSON.stringify({ kind: "operation.preparation", id: row.operation.buildRef?.id ?? id }),
            id,
            ...scopeValues(scope),
          ]
        );
        return parseRecord(changed).operation;
      });
    },

    /** Refuse accepted or exposed actions before making another provider build. */
    async requireRefreshablePreparation(
      scope: OperationScope,
      id: string,
      action: { actionId: string; version: number }
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        await assertUnsubmitted(tx, scope, row);
        assertCurrentAction(row.operation, action);
        if (isTerminalOperationStatus(row.operation.status))
          throw conflict("Terminal operation cannot be refreshed");
        if (row.operation.cancelRequestedAt !== null)
          throw conflict("Operation cancellation was requested");
        if (row.operation.nextAction?.type === "sign_transaction")
          throw conflict("The exposed wallet transaction must be reconciled before refreshing", {
            reason: "wallet_transaction_outcome_unknown",
          });
      });
    },

    /** Only an unsigned, undispatched action can be replaced without domain evidence. */
    async replacePreparedAction(
      scope: OperationScope,
      id: string,
      action: { actionId: string; version: number },
      prepared: PreparedOperationAction,
      evidence: OperationReplacementEvidence,
      purpose: "execute" | "cancel" = "execute",
      actionPrincipal?: MoneyPrincipal
    ): Promise<Operation> {
      const nextAction = operationNextActionSchema.parse(prepared.nextAction);
      const terms = operationTermsSchema.parse(prepared.terms);
      const buildRef = operationReferenceSchema.nullable().parse(prepared.buildRef);
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        await assertUnsubmitted(tx, scope, row);
        if (purpose === "cancel" && actionPrincipal === undefined)
          throw internalError("Cancellation action requires its authenticated principal");
        const principal =
          actionPrincipal === undefined
            ? row.actionPrincipal
            : moneyPrincipalSchema.parse(actionPrincipal);
        assertCurrentAction(row.operation, action);
        if (isTerminalOperationStatus(row.operation.status))
          throw conflict("Terminal operation cannot be refreshed");
        if (row.claimUntil !== null && Date.parse(row.claimUntil) > Date.now())
          throw conflict("Operation execution is in progress");
        if (row.operation.cancelRequestedAt !== null && purpose === "execute")
          throw conflict("Operation cancellation was requested");
        const attempt = await currentAttempt(tx, scope, row.operation);
        assertReplacementEvidence(attempt, evidence);
        if (row.operation.version >= 2_147_483_647)
          throw conflict("Operation action version is exhausted");
        const updated = await tx.queryOne(
          `UPDATE operations SET action_id = ?, action_version = action_version + 1, action_purpose = ?,
             status = 'prepared', next_action = ?::jsonb, terms = ?::jsonb, build_ref = ?::jsonb,
             action_principal = ?::jsonb, resource_ref = NULL, error = NULL,
             claim_token = NULL, claim_until = NULL, updated_at = sdp_iso_now()
           WHERE id = ? AND ${scopeSql} AND action_id = ? AND action_version = ? RETURNING ${OPERATION_COLUMNS}`,
          [
            `opa_${randomUUID()}`,
            purpose,
            JSON.stringify(nextAction),
            JSON.stringify(terms),
            sqlJson(buildRef),
            JSON.stringify(principal),
            id,
            ...scopeValues(scope),
            action.actionId,
            action.version,
          ]
        );
        if (updated === null) throw conflict("Operation changed during refresh");
        return parseRecord(updated).operation;
      });
    },

    /** Stable pending work backs off; progress restarts prompt observation without changing money state. */
    async releaseRecovery(scope: OperationScope, claim: OperationClaim): Promise<boolean> {
      return (
        (await db.execute(
          `UPDATE operations SET claim_token = NULL, claim_until = NULL,
           next_check_at = now() + make_interval(secs => CASE
             WHEN error IS NULL AND (next_action ->> 'type') IS DISTINCT FROM 'sign_in_provider' AND status IN (${sqlLiteralList(SDP_PROGRESS_OPERATION_STATUSES)})
               AND EXISTS (SELECT 1 FROM operation_attempts attempt
                 WHERE attempt.operation_id = operations.id
                   AND attempt.organization_id = operations.organization_id
                   AND attempt.project_id = operations.project_id
                   AND attempt.environment = operations.environment
                   AND attempt.action_id = operations.action_id
                   AND attempt.action_version = operations.action_version
                   AND attempt.execution_requested_at::timestamptz > now() - interval '2 minutes') THEN 2
             WHEN status <> ? THEN 15 ELSE
             LEAST(CASE WHEN next_action ->> 'type' = 'sign_in_provider' THEN 60 ELSE 300 END,
               15 * power(2, LEAST(recovery_check_count, 5))) END),
           recovery_check_count = CASE WHEN status <> ? THEN 0
             WHEN error IS NULL AND (next_action ->> 'type') IS DISTINCT FROM 'sign_in_provider' AND status IN (${sqlLiteralList(SDP_PROGRESS_OPERATION_STATUSES)})
               AND EXISTS (SELECT 1 FROM operation_attempts attempt
                 WHERE attempt.operation_id = operations.id
                   AND attempt.organization_id = operations.organization_id
                   AND attempt.project_id = operations.project_id
                   AND attempt.environment = operations.environment
                   AND attempt.action_id = operations.action_id
                   AND attempt.action_version = operations.action_version
                   AND attempt.execution_requested_at::timestamptz > now() - interval '2 minutes') THEN recovery_check_count
             ELSE LEAST(recovery_check_count + 1, 5) END
         WHERE id = ? AND ${scopeSql} AND claim_token = ? AND fence = ? AND claim_until > now()`,
          [
            claim.operation.status,
            claim.operation.status,
            claim.operation.id,
            ...scopeValues(scope),
            claim.token,
            claim.fence,
          ]
        )) === 1
      );
    },

    async release(scope: OperationScope, claim: OperationClaim): Promise<boolean> {
      return db.transaction(async (tx) => {
        const released = await tx.queryOne<{ due: boolean }>(
          `UPDATE operations SET claim_token = NULL, claim_until = NULL WHERE id = ? AND ${scopeSql}
             AND claim_token = ? AND fence = ? RETURNING next_check_at <= now() AS due`,
          [claim.operation.id, ...scopeValues(scope), claim.token, claim.fence]
        );
        if (released === null) return false;
        // Deliver only after the submission claim is released and this transaction commits.
        if (released.due)
          await tx.execute("SELECT pg_notify(?, ?)", [OPERATION_WAKE_CHANNEL, scope.environment]);
        return true;
      });
    },
  };
}

export type OperationsRepository = ReturnType<typeof createOperationsRepository>;
