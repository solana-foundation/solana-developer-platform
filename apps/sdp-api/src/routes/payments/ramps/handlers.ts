import { RAMP_PROVIDER_CLIENTS, resolveRampProviderClient } from "@sdp/payments/ramps";
import type { RampProvider } from "@sdp/payments/ramps/types";
import { isCancelableRampTransferStatus, isRampTransferType } from "@sdp/types/payments";
import { isRetiredRampProviderId } from "@sdp/types/provider-access";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { badRequest, conflict, forbidden, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository, rampRuntime } from "@/routes/payments/context";
import { mapTransferRow } from "@/routes/payments/mappers";
import { resolveScope } from "@/routes/payments/wallets";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { auditedRampWrite } from "@/services/payments/ramp-audit";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import { admitRamp } from "./admission";
import type { cancelRampTransferSchema, simulateSandboxTransferSchema } from "./schemas";

// The provider's cancel only tidies its side; SDP's cancel already holds.
const PROVIDER_CANCEL_TIMEOUT_MS = 5_000;

/**
 * Cancels the sale a provider holds for a canceled off-ramp, best-effort:
 * SDP's guarded cancel already stops any deposit, so a failure here only
 * leaves the provider's sale to expire on its own.
 */
async function cancelProviderSale(c: AppContext, transfer: PaymentTransferRow): Promise<void> {
  if (
    transfer.type !== "offramp" ||
    transfer.provider === null ||
    isRetiredRampProviderId(transfer.provider)
  ) {
    return;
  }
  const client: RampProvider = RAMP_PROVIDER_CLIENTS[transfer.provider];
  if (client.cancelOfframpSale === undefined) return;
  const event = {
    event: "sdp_api_ramp_provider_cancel",
    provider: transfer.provider,
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
  };
  try {
    const outcome = await client.cancelOfframpSale(
      rampRuntime(c, transfer.provider),
      transfer.id,
      AbortSignal.timeout(PROVIDER_CANCEL_TIMEOUT_MS)
    );
    logEvent(outcome === "not_cancelable" ? "warn" : "info", { ...event, outcome });
  } catch (error) {
    logEvent("warn", { ...event, outcome: "unknown", ...describeError(error) });
  }
}

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
  // Canceling a canceled transfer answers it again, and retries the provider.
  if (transfer.status === "canceled") {
    await cancelProviderSale(c, transfer);
    return success(c, { transfer: mapTransferRow(transfer) });
  }
  if (!isCancelableRampTransferStatus(transfer.status)) {
    throw badRequest(`Transfer can no longer be canceled (status: ${transfer.status}).`);
  }

  // The cancel and its record commit together; the provider hears of it after.
  const updated = await auditedRampWrite(
    c,
    "cancel",
    (audited) =>
      audited.transitionRampTransfer({
        transferId: transfer.id,
        organizationId: scope.auth.organizationId,
        projectId,
        transition: "canceled",
        updatedAt: new Date().toISOString(),
      }),
    { fromStatus: transfer.status }
  );
  if (!updated) {
    const current = await repository.getTransferById({
      transferId: transfer.id,
      organizationId: scope.auth.organizationId,
      projectId,
    });
    if (current?.status === "canceled") {
      return success(c, { transfer: mapTransferRow(current) });
    }
    throw conflict("Transfer status changed before it could be canceled.");
  }

  await cancelProviderSale(c, updated);
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
  if (transfer.provider === null) {
    throw internalError("On-ramp transfer has no provider.");
  }
  const provider = resolveRampProviderClient(transfer.provider).id;
  await assertProviderAvailable(c, { family: "ramps", provider });
  throw badRequest(`Sandbox simulation is not available for provider: ${provider}.`);
}
