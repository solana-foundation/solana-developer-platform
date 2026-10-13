import { isTerminalRampTransferStatus } from "@sdp/types";
import type { PaymentTransferRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { noContent } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository } from "../../context";
import type { coinbaseRampEventSchema } from "./schemas";

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
  const receivedAt = new Date().toISOString();
  await getPaymentsRepository(c).updateTransfer({
    transferId: transfer.id,
    expectedStatus: transfer.status,
    providerData: { clientEvent: { ...event, advisory: true, receivedAt } },
    updatedAt: receivedAt,
  });
  return noContent(c);
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
    return noContent(c);
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
