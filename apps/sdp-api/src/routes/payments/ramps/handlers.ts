import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_FIAT,
  bvnkOnrampRemittance,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { readMuralOrganization } from "@sdp/payments/ramps/providers/mural/provider-data";
import { parseDecimalAmount, toNumberAmount } from "@sdp/solana/amount";
import { CANCELABLE_RAMP_TRANSFER_STATUSES, isCancelableRampTransferStatus } from "@sdp/types";
import { getDb } from "@/db";
import {
  createPostgresBvnkOnrampTransfersRepository,
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
import { resolveMuralOnrampAccount } from "./providers/mural";

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

  const body = c.req.valid("json");

  let transaction: unknown;
  switch (body.provider) {
    case "lightspark":
      transaction = await RAMP_PROVIDER_CLIENTS.lightspark.sandboxSend(
        rampRuntime(c),
        body.payload
      );
      break;
    case "bvnk": {
      const scope = await resolveScope(c);
      const projectId = requireProjectId(c);
      const transfer = await getPaymentsRepository(c).getTransferById({
        transferId: body.payload.transferId,
        organizationId: scope.auth.organizationId,
        projectId,
      });
      if (!transfer) {
        throw notFound("Transfer");
      }
      if (transfer.provider !== "bvnk" || transfer.type !== "onramp") {
        throw badRequest("Transfer is not a BVNK on-ramp transfer.");
      }
      if (transfer.status !== "awaiting_payment") {
        throw badRequest("Transfer is not awaiting payment for a BVNK sandbox pay-in.");
      }
      if (transfer.custody_wallet_id === null) {
        throw internalError("BVNK on-ramp transfer has no destination custody wallet.");
      }
      assertPaymentWalletExactAccess(c, transfer.custody_wallet_id, ["payments:write"]);
      if (transfer.counterparty_id === null) {
        throw internalError("BVNK on-ramp transfer has no counterparty.");
      }
      const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
        counterpartyId: transfer.counterparty_id,
        organizationId: scope.auth.organizationId,
        projectId,
      });
      if (!counterparty) {
        throw notFound("Counterparty");
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
      if (transfer.fiat_amount === null || transfer.fiat_currency === null) {
        throw internalError("BVNK on-ramp transfer has no fiat amount.");
      }
      const claimedSimulation = await createPostgresBvnkOnrampTransfersRepository(
        getDb(c.env)
      ).claimPayinSimulation({
        transferId: transfer.id,
        requestedAt: new Date().toISOString(),
      });
      if (claimedSimulation === null) {
        throw conflict("BVNK sandbox pay-in simulation was already requested for this transfer.");
      }
      transaction = await RAMP_PROVIDER_CLIENTS.bvnk.simulatePayin(rampRuntime(c), {
        walletId: fundingRow.external_account_reference,
        amount: toNumberAmount(transfer.fiat_amount),
        currency: transfer.fiat_currency,
        originatorName: counterparty.display_name,
        remittanceInformation: bvnkOnrampRemittance(transfer.id),
        idempotencyKey: transfer.id,
      });
      break;
    }
    case "mural": {
      const payload = body.payload;
      const scope = await resolveScope(c);
      const projectId = requireProjectId(c);
      const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
        counterpartyId: payload.counterpartyId,
        organizationId: scope.auth.organizationId,
        projectId,
      });
      if (!counterparty) {
        throw new AppError("NOT_FOUND", "Counterparty not found");
      }
      const org = readMuralOrganization(counterparty.provider_data);
      if (!org.id) {
        throw badRequest("Mural organization is not provisioned yet for this counterparty.");
      }
      const account = await resolveMuralOnrampAccount(c, org);
      if (!account) {
        throw badRequest("Mural account is not active yet for this counterparty.");
      }
      const rail = {
        USD: "wire",
        MXN: "spei",
        BRL: "pix",
        ARS: "cvu",
      } as const satisfies Record<typeof payload.fiatCurrency, "wire" | "spei" | "pix" | "cvu">;
      transaction = await RAMP_PROVIDER_CLIENTS.mural.simulatePayin(rampRuntime(c), {
        organizationId: org.id,
        destinationAccountId: account.id,
        rail: rail[payload.fiatCurrency],
        amountValue: String(parseDecimalAmount(String(payload.amount), 2)),
        currencySymbol: payload.fiatCurrency,
      });
      break;
    }
  }

  return success(c, { transaction });
}
