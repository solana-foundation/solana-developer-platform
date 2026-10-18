import { resolveRampProviderClient } from "@sdp/payments/ramps";
import {
  CANCELABLE_RAMP_TRANSFER_STATUSES,
  isCancelableRampTransferStatus,
  isRampTransferType,
} from "@sdp/types/payments";
import { requireProjectId } from "@/lib/auth";
import { badRequest, conflict, forbidden, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import { getPaymentsRepository } from "../context";
import { mapTransferRow } from "../mappers";
import { assertPaymentWalletExactAccess, resolveScope } from "../wallets";
import { admitRamp } from "./admission";
import type { cancelRampTransferSchema, simulateSandboxTransferSchema } from "./schemas";

export async function cancelRampTransfer(c: ValidatedBodyContext<typeof cancelRampTransferSchema>) {
  const input = c.req.valid("json");
  const scope = await resolveScope(c);
  const projectId = requireProjectId(c);
  const repository = getPaymentsRepository(c);

  const transfer = await repository.getTransferById({
    transferId: input.transferId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Transfer");
  }
  if (!isRampTransferType(transfer.type)) {
    throw badRequest("Only ramp transfers can be canceled through this endpoint.");
  }
  await admitRamp(c, { need: "cancel", transfer });
  if (!isCancelableRampTransferStatus(transfer.status)) {
    throw badRequest(`Transfer can no longer be canceled (status: ${transfer.status}).`);
  }

  const updated = await repository.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: scope.auth.organizationId,
    projectId,
    fromStatuses: CANCELABLE_RAMP_TRANSFER_STATUSES,
    toStatus: "canceled",
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw conflict("Transfer status changed before it could be canceled.");
  }

  return success(c, { transfer: mapTransferRow(updated) });
}

export async function simulateSandboxTransfer(
  c: ValidatedBodyContext<typeof simulateSandboxTransferSchema>
) {
  if (resolveSdpEnvironment(c) !== "sandbox") {
    throw forbidden("Sandbox transfer simulation is only available in sandbox mode");
  }

  const { transferId } = c.req.valid("json");
  const scope = await resolveScope(c);
  const projectId = requireProjectId(c);
  const repository = getPaymentsRepository(c);

  const transfer = await repository.getTransferById({
    transferId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Transfer");
  }
  if (transfer.type !== "onramp") {
    throw badRequest("Only on-ramp transfers can be simulated.");
  }
  if (transfer.status !== "awaiting_payment") {
    throw conflict(`Transfer is not awaiting payment (status: ${transfer.status}).`);
  }
  if (transfer.custody_wallet_id === null) {
    throw internalError("On-ramp transfer has no destination custody wallet.");
  }
  assertPaymentWalletExactAccess(c, transfer.custody_wallet_id, ["payments:write"]);
  if (transfer.provider === null) {
    throw internalError("On-ramp transfer has no provider.");
  }
  const provider = resolveRampProviderClient(transfer.provider).id;
  await assertProviderAvailable(c, { family: "ramps", provider });
  throw badRequest(`Sandbox simulation is not available for provider: ${provider}.`);
}
