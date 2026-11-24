import { parseArgs } from "node:util";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { isRedemptionReleaseOperatorRecoveryStatus, type Operation } from "@sdp/types/operations";
import { signature } from "@solana/kit";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  createOperationsRepository,
  type OperationAttempt,
} from "@/db/repositories/operations.repository";
import { conflict, internalError, notFound } from "@/lib/errors";
import { createSystemAuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { readFinalizedTransaction } from "./strategy-redemption-release.service";

/** Deliberate operator attestation, never supplied by a public operation request. */
export const redemptionReleaseRecoverySchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  environment: z.enum(SDP_ENVIRONMENTS),
  operationId: z.string().trim().min(1),
  transactionId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  signature: z.string().trim().min(1),
  operator: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  ticket: z.string().trim().min(1).max(128),
  evidence: z.string().url().startsWith("https://").max(2_000),
  attestation: z.literal("verified_current_redemption_release"),
});

/** Exact accepted release identity plus the operator's durable review evidence. */
export type RedemptionReleaseRecoveryInput = z.infer<typeof redemptionReleaseRecoverySchema>;

type ReceiptReader = (
  value: string
) => Promise<Awaited<ReturnType<typeof readFinalizedTransaction>>>;

/** Parse the explicit operator command; unknown flags and extra arguments fail closed. */
export function parseRedemptionReleaseRecoveryArgs(
  argv: readonly string[]
): RedemptionReleaseRecoveryInput {
  const { values, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      "organization-id": { type: "string" },
      "project-id": { type: "string" },
      environment: { type: "string" },
      "operation-id": { type: "string" },
      "transaction-id": { type: "string" },
      "attempt-id": { type: "string" },
      signature: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      ticket: { type: "string" },
      evidence: { type: "string" },
      attestation: { type: "string" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate argument: --${token.name}`);
    seen.add(token.name);
  }
  return redemptionReleaseRecoverySchema.parse({
    organizationId: values["organization-id"],
    projectId: values["project-id"],
    environment: values.environment,
    operationId: values["operation-id"],
    transactionId: values["transaction-id"],
    attemptId: values["attempt-id"],
    signature: values.signature,
    operator: values.operator,
    reason: values.reason,
    ticket: values.ticket,
    evidence: values.evidence,
    attestation: values.attestation,
  });
}

function requireAcceptedRelease(
  operation: Operation,
  attempt: OperationAttempt | null,
  input: RedemptionReleaseRecoveryInput
): OperationAttempt & { signature: string; signedTransaction: string } {
  if (
    operation.kind !== "earn.withdraw" ||
    operation.resourceRef?.kind !== "earn.redemption_release" ||
    operation.resourceRef.id !== input.transactionId ||
    operation.buildRef?.kind !== "earn.queued_transaction" ||
    operation.buildRef.id !== input.transactionId ||
    attempt === null ||
    attempt.id !== input.attemptId ||
    attempt.signature !== input.signature ||
    attempt.signedTransaction === null ||
    attempt.executionRequestedAt === null
  )
    throw conflict("Recovery does not match the exact accepted redemption release");
  if (!isRedemptionReleaseOperatorRecoveryStatus(operation.status))
    throw conflict("Only a settling redemption release can be recovered");
  return { ...attempt, signature: input.signature, signedTransaction: attempt.signedTransaction };
}

/**
 * Record an operator-verified release when automatic provider event evidence is unavailable.
 * Requires a fresh finalized-success receipt for the exact accepted signature. Review evidence,
 * completion and PDA cooldown commit together; the ordinary decoder and financial history stay
 * unchanged. Never signs, broadcasts or assigns a token amount.
 */
export async function recoverCurrentRedemptionRelease(
  env: Env,
  rawInput: RedemptionReleaseRecoveryInput,
  readReceipt: ReceiptReader = (value) =>
    readFinalizedTransaction(createClusterRpc({ timeoutMs: 2_000 }), value)
): Promise<{ operationId: string; status: "completed"; replayed: boolean }> {
  const input = redemptionReleaseRecoverySchema.parse(rawInput);
  signature(input.signature);
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
  };
  const cluster = currentClusterScope();
  if (
    cluster.environment !== scope.environment ||
    (cluster.projectId !== null && cluster.projectId !== scope.projectId)
  )
    throw internalError("Recovery requires the operation's cluster scope");
  const db = getDb(env);
  const operations = createOperationsRepository(db);
  const record = await operations.get(scope, input.operationId);
  if (record === null) throw notFound("Operation");
  const attempt = requireAcceptedRelease(
    record.operation,
    await operations.getCurrentAttempt(scope, input.operationId),
    input
  );
  const release = { ...scope, transactionId: input.transactionId, attemptId: input.attemptId };
  const accepted = {
    ...release,
    signature: attempt.signature,
    signedTransaction: attempt.signedTransaction,
  };
  const build =
    await createPostgresEarnVaultWithdrawalRequestsRepository(db).consumeCurrentRedemptionRelease(
      accepted
    );
  if (record.operation.status === "completed") {
    if (build.release_finalized_at === null)
      throw conflict("Completed release has no finalized evidence");
    return { operationId: input.operationId, status: "completed", replayed: true };
  }
  const receipt = await readReceipt(attempt.signature);
  if (
    receipt === null ||
    receipt.signature !== attempt.signature ||
    !receipt.executionResultKnown ||
    receipt.error !== null
  )
    throw conflict("Recovery requires the exact accepted transaction's finalized success");
  return createSystemAuditService(env).logSystemWithin(async (tx) => {
    const claimedOperations = createOperationsRepository(tx);
    const claim = await claimedOperations.claimRecovery(scope, input.operationId);
    if (claim === null) throw conflict("Operation is leased or its next recovery check is not due");
    requireAcceptedRelease(claim.operation, claim.attempt, input);
    const queues = createPostgresEarnVaultWithdrawalRequestsRepository(tx);
    await queues.consumeCurrentRedemptionRelease(accepted);
    await queues.recordCurrentRedemptionReleaseFinalized(release);
    await claimedOperations.transition(scope, claim, {
      status: "completed",
      nextAction: null,
      resourceRef: { kind: "earn.redemption_release", id: input.transactionId },
      error: null,
    });
    await claimedOperations.release(scope, claim);
    return {
      entry: {
        action: "maintenance" as const,
        resourceType: "earn_operation" as const,
        resourceId: input.operationId,
        organizationId: input.organizationId,
        status: "success" as const,
        metadata: {
          operation: "recover_current_redemption_release",
          projectId: input.projectId,
          environment: input.environment,
          transactionId: input.transactionId,
          attemptId: input.attemptId,
          signature: input.signature,
          operator: input.operator,
          reason: input.reason,
          ticket: input.ticket,
          evidence: input.evidence,
          attestation: input.attestation,
        },
      },
      result: { operationId: input.operationId, status: "completed" as const, replayed: false },
    };
  });
}
