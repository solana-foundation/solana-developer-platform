import { RAMP_PROVIDER_CLIENTS, resolveRampProviderClient } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_FIAT,
  bvnkOnrampRemittance,
  readBvnkOnrampTransferData,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { toNumberAmount } from "@sdp/solana/amount";
import { CANCELABLE_RAMP_TRANSFER_STATUSES, isCancelableRampTransferStatus } from "@sdp/types";
import { getDb } from "@/db";
import {
  createPostgresCounterpartyProviderAccountsRepository,
  isRampTransferType,
} from "@/db/repositories";
import { requireProjectId } from "@/lib/auth";
import { badRequest, conflict, forbidden, internalError, notFound } from "@/lib/errors";
import { noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { sendOnceUnderTransferClaim } from "@/services/payments/transfer-claim";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import { getPaymentsRepository, rampRuntime, resolveSdpEnvironment } from "../context";
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
  if (transfer.counterparty_id === null) {
    throw internalError("On-ramp transfer has no counterparty.");
  }
  if (transfer.fiat_amount === null || transfer.fiat_currency === null) {
    throw internalError("On-ramp transfer has no fiat amount.");
  }
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: transfer.counterparty_id,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw notFound("Counterparty");
  }
  let simulate: () => Promise<unknown>;
  switch (provider) {
    case "bvnk": {
      // TODO(PRO-2035): remove with the legacy `bvnk.simulation` codec field.
      if (readBvnkOnrampTransferData(transfer.provider_data).simulation !== undefined) {
        throw conflict(
          "Sandbox simulation was already requested for this transfer. Create a new quote."
        );
      }
      const fundingRow = await createPostgresCounterpartyProviderAccountsRepository(
        getDb(c.env)
      ).getAccountByKindAndCurrency({
        organizationId: scope.auth.organizationId,
        projectId,
        counterpartyId: transfer.counterparty_id,
        provider: "bvnk",
        kind: "funding_wallet",
        fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
      });
      if (fundingRow === null || fundingRow.external_account_reference === null) {
        throw internalError("BVNK on-ramp counterparty has no funding wallet.");
      }
      const payload = {
        walletId: fundingRow.external_account_reference,
        amount: toNumberAmount(transfer.fiat_amount),
        currency: transfer.fiat_currency,
        originatorName: counterparty.display_name,
        remittanceInformation: bvnkOnrampRemittance(transfer.id),
        idempotencyKey: transfer.id,
      };
      simulate = () => RAMP_PROVIDER_CLIENTS.bvnk.simulatePayin(rampRuntime(c), payload);
      break;
    }
    case "moonpay":
    case "coinbase":
    case "stripe":
      throw badRequest(`Sandbox simulation is not available for provider: ${provider}.`);
    default: {
      const exhaustive: never = provider;
      throw internalError(`Unknown ramp provider: ${String(exhaustive)}`);
    }
  }

  const outcome = await sendOnceUnderTransferClaim({
    repository,
    transferId: transfer.id,
    organizationId: scope.auth.organizationId,
    projectId,
    expectedStatus: "awaiting_payment",
    claimKey: "sandboxSimulation",
    send: simulate,
  });
  if (!outcome.claimed) {
    throw conflict("Sandbox simulation was already requested for this transfer.");
  }
  return noContent(c);
}
