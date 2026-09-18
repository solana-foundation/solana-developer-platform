import { isTerminalRampTransferStatus } from "@sdp/types";
import type { PaymentTransferRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository } from "../../context";
import { mapTransferRow } from "../../mappers";
import type { coinbaseRampEventSchema } from "../../schemas";

function transferResponse(c: AppContext, row: PaymentTransferRow | null) {
  if (!row) {
    throw internalError("Failed to update the ramp transfer.");
  }
  return success(c, { transfer: mapTransferRow(row) });
}

/**
 * Browser/widget callbacks are useful telemetry, but they are not provider-authenticated
 * settlement evidence. Keep them in an explicitly advisory namespace and never derive a
 * transfer status from them.
 */
async function recordAdvisoryClientEvent(
  c: AppContext,
  transfer: PaymentTransferRow,
  event: Record<string, unknown>
) {
  const repo = getPaymentsRepository(c);
  const receivedAt = new Date().toISOString();
  const updated = await repo.updateTransfer({
    transferId: transfer.id,
    expectedStatus: transfer.status,
    providerData: { clientEvent: { ...event, advisory: true, receivedAt } },
    updatedAt: receivedAt,
  });
  if (updated) {
    return transferResponse(c, updated);
  }
  const current = await repo.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  return transferResponse(c, current);
}

export async function recordCoinbaseRampEvent(
  c: ValidatedBodyContext<typeof coinbaseRampEventSchema>
) {
  const event = c.req.valid("json");

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = getPaymentsRepository(c);

  const transfer = await repo.getTransferByProviderReference({
    provider: "coinbase",
    providerReference: event.orderId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Ramp transfer");
  }
  if (transfer.type !== "onramp") {
    throw badRequest("Coinbase events only apply to on-ramp transfers.");
  }
  if (isTerminalRampTransferStatus(transfer.status)) {
    return success(c, { transfer: mapTransferRow(transfer) });
  }

  switch (event.kind) {
    case "committed":
      return recordAdvisoryClientEvent(c, transfer, { kind: event.kind });
    case "errored":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        reason: event.reason,
      });
    default: {
      const exhaustive: never = event;
      throw internalError(`Unhandled Coinbase ramp event: ${JSON.stringify(exhaustive)}`);
    }
  }
}
