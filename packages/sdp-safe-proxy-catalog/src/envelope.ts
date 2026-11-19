import { z } from "zod";
import { SAFE_PROXY_MAX_BUDGET_MS, type SafeProxyOperation } from "./catalog";
import { safeProxyFailureSchema } from "./errors";

/**
 * How much longer than the budget a caller waits. The budget is a duration, not a clock time, so
 * Safe Proxy gives up before its caller whatever the two clocks say.
 */
export const SAFE_PROXY_CALLER_GRACE_MS = 2_000;

export function safeProxyCallPath(section: string, name: string): string {
  return `/v1/call/${section}/${name}`;
}

/** Names one stored customer credential by exact version, and the customer it must belong to. */
export const credentialReferenceSchema = z.strictObject({
  id: z.string().min(1).max(200),
  version: z.string().regex(/^[1-9][0-9]*$/),
  organizationId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
});
export type CredentialReference = z.infer<typeof credentialReferenceSchema>;

/** The envelope fields an operation's declaration adds to a call. */
export type SafeProxyDeclaredFields<Operation extends SafeProxyOperation> = (Operation extends {
  credential: "customer";
}
  ? { credential: CredentialReference }
  : unknown) &
  (Operation extends { kind: "changes" } ? { idempotencyKey: string } : unknown);

export function safeProxyRequestEnvelopeSchema(operation: SafeProxyOperation) {
  return z
    .strictObject({
      requestId: z.string().min(1).max(200),
      budgetMs: z.int().min(1).max(SAFE_PROXY_MAX_BUDGET_MS),
      credential: credentialReferenceSchema.optional(),
      idempotencyKey: z.string().min(1).max(255).optional(),
      input: operation.request,
    })
    .superRefine((envelope, context) => {
      if ((operation.credential === "customer") !== (envelope.credential !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["credential"],
          message: "present exactly when the operation uses a customer credential",
        });
      }
      if ((operation.kind === "changes") !== (envelope.idempotencyKey !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["idempotencyKey"],
          message: "present exactly when the operation changes something at the provider",
        });
      }
    });
}
export type SafeProxyRequestEnvelope = z.infer<ReturnType<typeof safeProxyRequestEnvelopeSchema>>;

export function safeProxyResponseEnvelopeSchema(operation: SafeProxyOperation) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), output: operation.response }),
    z.object({ ok: z.literal(false), error: safeProxyFailureSchema }),
  ]);
}
export type SafeProxyResponseEnvelope = z.infer<ReturnType<typeof safeProxyResponseEnvelopeSchema>>;
