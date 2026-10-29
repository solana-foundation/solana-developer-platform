import { runInClusterScope } from "@sdp/rpc/scope";
import type { Context, Next } from "hono";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";

/**
 * The payment request a public `/pay` link names.
 *
 * @param env - Worker bindings.
 * @param token - The link's public token.
 * @returns The payment request row.
 * @throws AppError `NOT_FOUND` when no request has that token.
 */
export async function findPaymentRequest(env: Env, token: string): Promise<PaymentRequestRow> {
  const row =
    await createSystemPaymentRequestsRepository(env).getPaymentRequestByPublicToken(token);
  if (!row) {
    throw notFound("Payment request");
  }
  return row;
}

/**
 * Run the rest of a `/pay` chain under the cluster scope of the Project the payment request was
 * created in: the link carries no project, so the stored row decides the cluster. It moves money
 * as that payment request (HOO-2099): the sponsor admits it only while the request is open.
 *
 * @param c - The request context, on a route with a `:token` parameter.
 * @param next - The rest of the route chain.
 * @returns Resolves when the chain has run.
 * @throws AppError `NOT_FOUND` when no request has that token, or the request has no Project.
 */
export async function paymentRequestScope(
  c: Context<{ Bindings: Env }, "/:token" | "/:token/tx">,
  next: Next
) {
  const { id: paymentRequestId, project_id: projectId } = await findPaymentRequest(
    c.env,
    c.req.param("token")
  );
  const project = await new ProjectService(getDb(c.env)).getProject(projectId);
  if (!project) {
    throw notFound("Payment request");
  }
  await runInClusterScope({ projectId: project.id, environment: project.environment }, () =>
    runAsMoneyPrincipal({ kind: "payment_request", paymentRequestId }, next)
  );
}
