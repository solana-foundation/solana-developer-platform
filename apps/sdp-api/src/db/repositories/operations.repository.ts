import { randomUUID } from "node:crypto";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  OPERATION_STATUSES,
  OPERATION_TRANSITIONS,
  type Operation,
  type OperationIntent,
  type OperationNextAction,
  type OperationProposalBinding,
  type OperationReference,
  type OperationSource,
  type OperationStatus,
  type OperationTerms,
  operationIntentSchema,
  operationNextActionSchema,
  operationProposalBindingSchema,
  operationReferenceSchema,
  operationSchema,
  operationSourceSchema,
  operationTermsSchema,
  TERMINAL_OPERATION_STATUSES,
} from "@sdp/types/operations";
import { z } from "zod";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";
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
  status?: OperationStatus;
  ownerAddress?: string;
  walletId?: string;
  positionId?: string;
  allowedWalletIds?: readonly string[];
}

/** The current version's execution record; signed bytes and account binding are first-write-wins. */
export interface OperationAttempt {
  id: string;
  operationId: string;
  actionId: string;
  version: number;
  selectedOptionId: string | null;
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
}

/** A validated, side-effect-free action ready for display. */
export interface PreparedOperationAction {
  nextAction: OperationNextAction;
  terms: OperationTerms;
  buildRef: OperationReference | null;
}

/** First-write-wins request input; preparation never initiates signing or approval. */
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
});
const attemptRowSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  action_id: z.string(),
  action_version: z.number(),
  selected_option_id: z.string().nullable(),
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
const OPERATION_COLUMNS =
  "*, CASE WHEN claim_until IS NULL THEN NULL ELSE to_char(claim_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END AS claim_until";
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
    selectedOptionId: row.selected_option_id,
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
function isTerminal(status: OperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.some((candidate) => candidate === status);
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
    return parseAttempt(updated);
  }
  return {
    get: (scope: OperationScope, id: string) => read(db, scope, id, false),

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
      if (input.kind !== undefined) {
        filters.push("kind = ?");
        values.push(input.kind);
      }
      if (input.status !== undefined) {
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
      action: { actionId: string; version: number; optionId?: string },
      leaseSeconds = 60,
      allowCancelledSignedRecovery = false
    ): Promise<OperationClaim> {
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
        throw new Error("Operation execution lease must be between 1 and 300 seconds");
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        assertCurrentAction(row.operation, action);
        if (isTerminal(row.operation.status)) throw conflict("Operation is already terminal");
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
        if (attempt !== null && attempt.selectedOptionId !== (action.optionId ?? null))
          throw conflict("Operation action already selected a different option");
        if (attempt === null) {
          if (
            row.operation.nextAction?.type !== "execute" &&
            row.operation.nextAction?.type !== "sign_transaction"
          )
            throw conflict("Operation has no executable action");
          const created = await tx.queryOne(
            `INSERT INTO operation_attempts (id, operation_id, organization_id, project_id, environment, action_id, action_version, build_ref, selected_option_id, principal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb) RETURNING *`,
            [
              `opat_${randomUUID()}`,
              id,
              ...scopeValues(scope),
              action.actionId,
              action.version,
              sqlJson(row.operation.buildRef),
              action.optionId ?? null,
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

    /** Lease a previously requested execution or recover its retained effects; never create an attempt. */
    async claimRecovery(scope: OperationScope, id: string): Promise<OperationClaim | null> {
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        if (isTerminal(row.operation.status)) return null;
        if (row.claimUntil !== null && Date.parse(row.claimUntil) > Date.now()) return null;
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
          `UPDATE operations SET claim_token = ?, claim_until = now() + (? * interval '1 second'), fence = fence + 1
           WHERE id = ? AND ${scopeSql} RETURNING ${OPERATION_COLUMNS}`,
          [token, OPERATION_WORKER_LEASE_MS / 1000, id, ...scopeValues(scope)]
        );
        const current = parseRecord(changed);
        return {
          operation: current.operation,
          attempt,
          token,
          fence: current.fence,
          purpose: current.actionPurpose,
          recoveryRequired:
            attempt.dispatchStartedAt !== null ||
            attempt.resourceRef !== null ||
            attempt.observationOnly ||
            (current.operation.cancelRequestedAt !== null && current.actionPurpose === "execute"),
        };
      });
    },

    /** Only a server-controlled unsigned preparation proves no independent broadcast was possible. */
    async cancelUndispatched(scope: OperationScope, id: string): Promise<Operation | null> {
      return db.transaction(async (tx) => {
        const row = await requireRecord(tx, scope, id, true);
        if (isTerminal(row.operation.status)) return row.operation;
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
          "walletId" in row.source &&
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
      return true;
    },

    /** Queue explicit authorization durably; no signing, approval or broadcast happens here. */
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
        if (isTerminal(before.status)) throw conflict("Terminal operation cannot change");
        if (
          (update.status === "completed" || update.status === "cancelled") &&
          update.resourceRef === null
        )
          throw conflict("Terminal settlement requires an authoritative resource reference");
        if (before.resourceRef !== null && !sameJson(before.resourceRef, update.resourceRef))
          throw conflict("Operation settlement resource changed");
        const nextAction = isTerminal(update.status)
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
        return parseRecord(changed).operation;
      });
    },

    /** Cancellation records intent; no acknowledgement is projected as a terminal outcome. */
    async requestCancellation(scope: OperationScope, id: string): Promise<Operation> {
      const row = await db.queryOne(
        `UPDATE operations SET cancel_requested_at = COALESCE(cancel_requested_at, sdp_iso_now()),
           updated_at = sdp_iso_now() WHERE id = ? AND ${scopeSql}
           AND status NOT IN ('completed', 'failed', 'cancelled') RETURNING ${OPERATION_COLUMNS}`,
        [id, ...scopeValues(scope)]
      );
      if (row !== null) return parseRecord(row).operation;
      return (await requireRecord(db, scope, id, false)).operation;
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
        if (purpose === "cancel" && actionPrincipal === undefined)
          throw internalError("Cancellation action requires its authenticated principal");
        const principal =
          actionPrincipal === undefined
            ? row.actionPrincipal
            : moneyPrincipalSchema.parse(actionPrincipal);
        assertCurrentAction(row.operation, action);
        if (isTerminal(row.operation.status))
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

    async release(scope: OperationScope, claim: OperationClaim): Promise<boolean> {
      return (
        (await db.execute(
          `UPDATE operations SET claim_token = NULL, claim_until = NULL WHERE id = ? AND ${scopeSql}
           AND claim_token = ? AND fence = ?`,
          [claim.operation.id, ...scopeValues(scope), claim.token, claim.fence]
        )) === 1
      );
    },
  };
}

export type OperationsRepository = ReturnType<typeof createOperationsRepository>;
