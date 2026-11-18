import { createHash } from "node:crypto";
import {
  type Operation,
  type OperationIntent,
  type OperationProposalBinding,
  type OperationSource,
  operationIntentSchema,
  operationSchema,
  type SubmitOperation,
  submitOperationSchema,
} from "@sdp/types/operations";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  createOperationsRepository,
  type OperationClaim,
  type OperationListFilters,
  type OperationRecord,
  type OperationScope,
  type OperationsRepository,
  type OperationUpdate,
  type PreparedOperationAction,
} from "@/db/repositories/operations.repository";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { currentMoneyPrincipal } from "@/lib/money-principal";
import type { Env } from "@/types/env";

const requestKeySchema = z.string().trim().min(1).max(256);
const signedAttemptSchema = z.strictObject({
  signedTransaction: z
    .string()
    .min(1)
    .max(1700)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signature: z.string().min(1).max(128),
  lastValidBlockHeight: z.string().regex(/^\d+$/),
});

/** Preparation and submission must retain the principal and exact reviewed action. */
export function assertReviewedOperationAction(
  record: OperationRecord,
  action: { actionId: string; version: number }
): void {
  const principal = currentMoneyPrincipal();
  if (principal === null || JSON.stringify(principal) !== JSON.stringify(record.actionPrincipal))
    throw conflict("Operation requires its authenticated action principal");
  if (record.operation.actionId !== action.actionId || record.operation.version !== action.version)
    throw conflict("Operation action or terms version changed", {
      reason: "stale_operation_action",
    });
}

/**
 * Coordinates durable actions without signing or provider effects. Callers must
 * authorize all stored resources before reaching this service and re-admit the
 * recorded principal at the actual custody/sponsorship boundary.
 */
export class OperationsService {
  constructor(readonly repository: OperationsRepository) {}

  /** Domain replay survives HTTP-key retention without another provider build. */
  async replayPreparation(
    scope: OperationScope,
    input: { intent: OperationIntent; requestKey: string }
  ): Promise<Operation | null> {
    const intent = operationIntentSchema.parse(input.intent);
    const record = await this.repository.findByRequest(
      scope,
      intent.kind,
      requestKeySchema.parse(input.requestKey)
    );
    if (record === null) return null;
    const fingerprint = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
    if (
      fingerprint !== record.fingerprint ||
      JSON.stringify(currentMoneyPrincipal()) !== JSON.stringify(record.principal)
    ) {
      throw conflict("Idempotency key already used with different operation input");
    }
    return record.operation;
  }

  /** Create or replay the immutable request after a side-effect-free build. */
  async prepare(
    scope: OperationScope,
    input: {
      intent: OperationIntent;
      source: OperationSource;
      requestKey: string;
      prepared: PreparedOperationAction;
    }
  ): Promise<{ operation: Operation; replayed: boolean }> {
    const intent = operationIntentSchema.parse(input.intent);
    const requestKey = requestKeySchema.parse(input.requestKey);
    const principal = currentMoneyPrincipal();
    if (principal === null)
      throw internalError("Operation preparation requires an authenticated money principal");
    const fingerprint = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
    const created = await this.repository.createOrReplay({
      ...scope,
      intent,
      source: input.source,
      principal,
      requestKey,
      fingerprint,
      prepared: input.prepared,
    });
    return { operation: created.record.operation, replayed: created.replayed };
  }

  /** Read only; a status poll never starts signing or broadcast. */
  async get(scope: OperationScope, id: string): Promise<Operation> {
    const record = await this.repository.get(scope, id);
    if (record === null) throw notFound("Operation");
    return record.operation;
  }

  /** Wallet feed by default; address-filtered history requires an explicit ownerAddress. */
  async list(
    scope: OperationScope,
    input: OperationListFilters & { limit?: number; cursor?: string }
  ) {
    const limit =
      input.limit === undefined ? 50 : z.number().int().min(1).max(100).parse(input.limit);
    let before: { createdAt: string; id: string } | null = null;
    if (input.cursor !== undefined) {
      const cursor = decodeKeysetCursor(input.cursor);
      if (cursor === null || !z.string().datetime().safeParse(cursor.value).success)
        throw badRequest("Invalid operation cursor");
      before = { createdAt: cursor.value, id: cursor.id };
    }
    const rows = await this.repository.list(scope, { ...input, limit: limit + 1, before });
    const operations = rows.slice(0, limit).map((row) => row.operation);
    const last = operations.at(-1);
    return {
      operations,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeKeysetCursor(last.createdAt, last.id)
          : null,
    };
  }

  /** Validate the displayed action before claiming it. A recovery claim cannot create another proposal. */
  async claimSubmission(
    scope: OperationScope,
    id: string,
    body: SubmitOperation
  ): Promise<OperationClaim> {
    const input = submitOperationSchema.parse(body);
    const record = await this.repository.get(scope, id);
    if (record === null) throw notFound("Operation");
    const operation = record.operation;
    assertReviewedOperationAction(record, input);
    const attempt = await this.repository.getAttempt(scope, id);
    const recovering =
      attempt !== null &&
      (attempt.executionRequestedAt !== null || attempt.dispatchStartedAt !== null);
    if (!recovering) {
      // Signed bytes may already have been broadcast independently. Expiry can
      // refuse a new custody proposal, never erase that recoverable submission.
      if (
        input.signedTransaction === undefined &&
        operation.terms.expiresAt !== null &&
        Date.parse(operation.terms.expiresAt) <= Date.now()
      )
        throw conflict("Operation terms expired; refresh before executing");
      if (
        operation.nextAction?.type === "sign_transaction" &&
        input.signedTransaction === undefined
      )
        throw badRequest("Sign the prepared transaction before executing this action");
      if (
        input.signedTransaction !== undefined &&
        operation.nextAction?.type !== "sign_transaction"
      )
        throw badRequest("This action does not accept a caller-signed transaction");
      if (
        operation.nextAction?.type !== "sign_transaction" &&
        operation.nextAction?.type !== "submit"
      )
        throw conflict("Operation is waiting for its advertised next action");
    }
    const cancelledSignedRecovery =
      input.signedTransaction !== undefined &&
      operation.nextAction?.type === "sign_transaction" &&
      operation.cancelRequestedAt !== null;
    return this.repository.claimAction(scope, id, input, 60, cancelledSignedRecovery);
  }

  /** Persist account binding before any provider create; no credentials are accepted. */
  recordProposalBinding(
    scope: OperationScope,
    claim: OperationClaim,
    binding: OperationProposalBinding
  ) {
    return this.repository.recordProposalBinding(scope, claim, binding);
  }

  /** Call only after exact-message and signature verification, before broadcast. */
  recordSignedAttempt(
    scope: OperationScope,
    claim: OperationClaim,
    input: z.infer<typeof signedAttemptSchema>
  ) {
    return this.repository.recordSignedAttempt(scope, claim, signedAttemptSchema.parse(input));
  }

  /** Persist the uncertain-outcome boundary before the first provider create or broadcast. */
  markDispatchStarted(scope: OperationScope, claim: OperationClaim) {
    return this.repository.markDispatchStarted(scope, claim);
  }

  /** Project domain observations without making the operation another settlement ledger. */
  transition(scope: OperationScope, claim: OperationClaim, update: OperationUpdate) {
    operationSchema.shape.status.parse(update.status);
    return this.repository.transition(scope, claim, update);
  }

  /** Cancel only a safe preparation before any submission has been accepted. */
  cancelPreparation(scope: OperationScope, id: string) {
    return this.repository.cancelPreparation(scope, id);
  }
}

/** The API's database-backed operation coordinator; it constructs no external clients. */
export function createOperationsService(env: Env): OperationsService {
  return new OperationsService(createOperationsRepository(getDb(env)));
}
