import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_FIAT,
  bvnkOnrampRemittance,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  readMuralOrganization,
  readMuralTransferAccountId,
} from "@sdp/payments/ramps/providers/mural/provider-data";
import { parseDecimalAmount, toNumberAmount } from "@sdp/solana/amount";
import {
  CANCELABLE_RAMP_TRANSFER_STATUSES,
  isCancelableRampTransferStatus,
  isMuralSandboxPayinCurrency,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  createPostgresCounterpartyProviderAccountsRepository,
  isRampTransferType,
} from "@/db/repositories";
import { requireProjectId } from "@/lib/auth";
import { AppError, badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import { getPaymentsRepository, rampRuntime, resolveSdpEnvironment } from "../context";
import { mapTransferRow } from "../mappers";
import { assertPaymentWalletExactAccess, resolveScope } from "../wallets";
import { MURAL_SANDBOX_PAYIN_RAIL_BY_CURRENCY } from "./providers/mural";

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
  if (!isCancelableRampTransferStatus(transfer.status)) {
    throw badRequest(`Transfer can no longer be canceled (status: ${transfer.status}).`);
  }

  if (transfer.provider === "bvnk" && transfer.type === "onramp") {
    if (transfer.custody_wallet_id === null) {
      throw internalError("BVNK on-ramp transfer has no custody wallet.");
    }
    assertPaymentWalletExactAccess(c, transfer.custody_wallet_id, ["payments:write"]);
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
    throw new AppError(
      "FORBIDDEN",
      "Sandbox transfer simulation is only available in sandbox mode"
    );
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
    throw badRequest(`Transfer is not awaiting payment (status: ${transfer.status}).`);
  }
  if (transfer.custody_wallet_id === null) {
    throw internalError("On-ramp transfer has no destination custody wallet.");
  }
  assertPaymentWalletExactAccess(c, transfer.custody_wallet_id, ["payments:write"]);
  if (transfer.provider === null) {
    throw internalError("On-ramp transfer has no provider.");
  }
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
  const row = {
    id: transfer.id,
    provider: transfer.provider,
    providerReference: transfer.provider_reference,
    providerData: transfer.provider_data,
    counterpartyId: transfer.counterparty_id,
    fiatAmount: transfer.fiat_amount,
    fiatCurrency: transfer.fiat_currency,
  };

  let simulate: () => Promise<unknown>;
  switch (row.provider) {
    case "lightspark": {
      const quoteId = row.providerReference;
      if (quoteId === null) {
        throw internalError("Lightspark on-ramp transfer has no quote reference.");
      }
      simulate = () =>
        RAMP_PROVIDER_CLIENTS.lightspark.sandboxSend(rampRuntime(c), {
          quoteId,
          currencyCode: row.fiatCurrency,
        });
      break;
    }
    case "bvnk": {
      const fundingRow = await createPostgresCounterpartyProviderAccountsRepository(
        getDb(c.env)
      ).getAccountByKindAndCurrency({
        organizationId: scope.auth.organizationId,
        projectId,
        counterpartyId: row.counterpartyId,
        provider: "bvnk",
        kind: "funding_wallet",
        fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
      });
      if (fundingRow === null || fundingRow.external_account_reference === null) {
        throw internalError("BVNK on-ramp counterparty has no funding wallet.");
      }
      const walletId = fundingRow.external_account_reference;
      simulate = () =>
        RAMP_PROVIDER_CLIENTS.bvnk.simulatePayin(rampRuntime(c), {
          walletId,
          amount: toNumberAmount(row.fiatAmount),
          currency: row.fiatCurrency,
          originatorName: counterparty.display_name,
          remittanceInformation: bvnkOnrampRemittance(row.id),
          idempotencyKey: row.id,
        });
      break;
    }
    case "mural": {
      const org = readMuralOrganization(counterparty.provider_data);
      if (!org.id) {
        throw internalError("Mural on-ramp counterparty has no organization.");
      }
      const organizationId = org.id;
      const fiatCurrency = row.fiatCurrency;
      if (!isMuralSandboxPayinCurrency(fiatCurrency)) {
        throw badRequest(`Mural sandbox pay-in does not support ${fiatCurrency}.`);
      }
      const destinationAccountId = readMuralTransferAccountId(row.providerData);
      simulate = () =>
        RAMP_PROVIDER_CLIENTS.mural.simulatePayin(rampRuntime(c), {
          organizationId,
          destinationAccountId,
          rail: MURAL_SANDBOX_PAYIN_RAIL_BY_CURRENCY[fiatCurrency],
          amountValue: String(parseDecimalAmount(row.fiatAmount, 2)),
          currencySymbol: fiatCurrency,
        });
      break;
    }
    case "moonpay":
    case "moneygram":
    case "coinbase":
    case "stripe":
      throw badRequest(`Sandbox simulation is not available for provider: ${row.provider}.`);
    default: {
      const exhaustive: never = row.provider;
      throw internalError(`Unknown ramp provider: ${String(exhaustive)}`);
    }
  }

  const now = new Date().toISOString();
  const claimed = await repository.claimTransferProviderData({
    transferId: row.id,
    organizationId: scope.auth.organizationId,
    projectId,
    expectedStatus: "awaiting_payment",
    claimPath: ["sandboxSimulation"],
    providerData: { sandboxSimulation: { requestedAt: now } },
    updatedAt: now,
  });
  if (claimed === null) {
    throw conflict("Sandbox simulation was already requested for this transfer.");
  }

  const transaction = await simulate();
  return success(c, { transaction });
}
