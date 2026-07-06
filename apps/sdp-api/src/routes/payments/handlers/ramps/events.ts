import { z } from "zod";
import type { PaymentTransferRow, PaymentTransferStatus } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { isRampEventProvider } from "@/lib/ramps/shared";
import { success } from "@/lib/response";
import { type AppContext, getPaymentsRepository } from "../../context";
import { mapTransferRow } from "../../mappers";
import { coinbaseRampEventSchema, moneygramRampEventSchema } from "../../schemas";

const TERMINAL_RAMP_STATUSES = [
  "completed",
  "failed",
  "expired",
] as const satisfies readonly PaymentTransferStatus[];

function isTerminalRampStatus(status: PaymentTransferStatus): boolean {
  return (TERMINAL_RAMP_STATUSES as readonly PaymentTransferStatus[]).includes(status);
}

function readMoneygramData(transfer: PaymentTransferRow): Record<string, unknown> {
  const value = transfer.provider_data.moneygram;
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw internalError("Transfer provider_data.moneygram is not an object.");
  }
  return value as Record<string, unknown>;
}

async function requireVerifiedCryptoLeg(
  c: AppContext,
  ramp: PaymentTransferRow,
  cryptoTransferId: string,
  options: { requireConfirmed: boolean }
): Promise<PaymentTransferRow> {
  const leg = await getPaymentsRepository(c).getTransferById({
    transferId: cryptoTransferId,
    organizationId: ramp.organization_id,
    projectId: ramp.project_id,
  });
  if (!leg) {
    throw notFound("Transfer");
  }
  if (leg.type !== "transfer") {
    throw badRequest("cryptoTransferId must reference a wallet transfer.");
  }
  if (!ramp.source_address) {
    throw internalError("Off-ramp transfer is missing its source address.");
  }
  if (leg.source_address !== ramp.source_address) {
    throw badRequest("Crypto transfer was not sent from the off-ramp source wallet.");
  }
  if (!leg.signature) {
    throw badRequest("Crypto transfer has no on-chain signature.");
  }
  if (options.requireConfirmed && leg.status !== "confirmed" && leg.status !== "finalized") {
    throw badRequest(`Crypto transfer is not confirmed on-chain (status: ${leg.status}).`);
  }
  return leg;
}

function transferResponse(c: AppContext, row: PaymentTransferRow | null) {
  if (!row) {
    throw internalError("Failed to update the ramp transfer.");
  }
  return success(c, { transfer: mapTransferRow(row) });
}

export async function recordRampProviderEvent(c: AppContext) {
  const provider = c.req.param("provider");
  if (!isRampEventProvider(provider)) {
    throw badRequest(`Unsupported ramp event provider: ${provider}.`);
  }

  const body = await c.req.json();
  switch (provider) {
    case "moneygram":
      return recordMoneygramRampEvent(c, body);
    case "coinbase":
      return recordCoinbaseRampEvent(c, body);
    default: {
      const exhaustive: never = provider;
      throw internalError(`Unhandled ramp event provider: ${String(exhaustive)}`);
    }
  }
}

async function recordCoinbaseRampEvent(c: AppContext, body: unknown) {
  const parsed = coinbaseRampEventSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }
  const event = parsed.data;

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
  if (isTerminalRampStatus(transfer.status)) {
    return success(c, { transfer: mapTransferRow(transfer) });
  }

  const now = new Date().toISOString();
  switch (event.kind) {
    case "committed": {
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "settling",
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    case "errored": {
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "failed",
        error: event.reason,
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    default: {
      const exhaustive: never = event;
      throw internalError(`Unhandled Coinbase ramp event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function recordMoneygramRampEvent(c: AppContext, body: unknown) {
  const parsed = moneygramRampEventSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }
  const event = parsed.data;

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = getPaymentsRepository(c);

  const transfer = await repo.getTransferByProviderReference({
    provider: "moneygram",
    providerReference: event.sessionId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Ramp transfer");
  }
  if (transfer.type !== "offramp") {
    throw badRequest("MoneyGram events only apply to off-ramp transfers.");
  }
  if (isTerminalRampStatus(transfer.status)) {
    return success(c, { transfer: mapTransferRow(transfer) });
  }

  const moneygramData = readMoneygramData(transfer);
  const now = new Date().toISOString();

  switch (event.kind) {
    case "signed": {
      if (transfer.status === "settling") {
        if (moneygramData.cryptoTransferId === event.cryptoTransferId) {
          return success(c, { transfer: mapTransferRow(transfer) });
        }
        throw conflict("Off-ramp transfer is already settling a different crypto transfer.");
      }
      if (transfer.status !== "pending") {
        throw conflict(`Cannot record a signed event while the transfer is ${transfer.status}.`);
      }
      const leg = await requireVerifiedCryptoLeg(c, transfer, event.cryptoTransferId, {
        requireConfirmed: false,
      });
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "settling",
        amount: leg.amount,
        providerData: {
          ...transfer.provider_data,
          moneygram: {
            ...moneygramData,
            cryptoTransferId: leg.id,
            solanaTxSignature: leg.signature,
          },
        },
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    case "completed": {
      if (transfer.status !== "pending" && transfer.status !== "settling") {
        throw conflict(`Cannot record a completed event while the transfer is ${transfer.status}.`);
      }
      if (
        transfer.status === "settling" &&
        moneygramData.cryptoTransferId !== event.cryptoTransferId
      ) {
        throw conflict("Off-ramp transfer is already settling a different crypto transfer.");
      }
      const leg = await requireVerifiedCryptoLeg(c, transfer, event.cryptoTransferId, {
        requireConfirmed: true,
      });
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "completed",
        amount: leg.amount,
        providerData: {
          ...transfer.provider_data,
          moneygram: {
            ...moneygramData,
            cryptoTransferId: leg.id,
            solanaTxSignature: leg.signature,
            transactionId: event.transactionId,
            payoutAmount: event.payoutAmount,
            payoutStatus: event.payoutStatus,
            ...(event.referenceNumber ? { referenceNumber: event.referenceNumber } : {}),
          },
        },
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    case "errored": {
      const moneygram = {
        ...moneygramData,
        ...(event.transactionId ? { transactionId: event.transactionId } : {}),
      };
      if (transfer.status === "settling") {
        const updated = await repo.updateTransfer({
          transferId: transfer.id,
          providerData: {
            ...transfer.provider_data,
            moneygram: { ...moneygram, lastWidgetError: event.reason },
          },
          updatedAt: now,
        });
        return transferResponse(c, updated);
      }
      if (event.cryptoTransferId) {
        const leg = await requireVerifiedCryptoLeg(c, transfer, event.cryptoTransferId, {
          requireConfirmed: false,
        });
        const updated = await repo.updateTransfer({
          transferId: transfer.id,
          status: "settling",
          amount: leg.amount,
          providerData: {
            ...transfer.provider_data,
            moneygram: {
              ...moneygram,
              cryptoTransferId: leg.id,
              solanaTxSignature: leg.signature,
              lastWidgetError: event.reason,
            },
          },
          updatedAt: now,
        });
        return transferResponse(c, updated);
      }
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "failed",
        error: event.reason,
        providerData: { ...transfer.provider_data, moneygram },
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    case "closed": {
      if (transfer.status !== "pending") {
        return success(c, { transfer: mapTransferRow(transfer) });
      }
      const updated = await repo.updateTransfer({
        transferId: transfer.id,
        status: "expired",
        updatedAt: now,
      });
      return transferResponse(c, updated);
    }
    default: {
      const exhaustive: never = event;
      throw internalError(`Unhandled MoneyGram ramp event: ${JSON.stringify(exhaustive)}`);
    }
  }
}
