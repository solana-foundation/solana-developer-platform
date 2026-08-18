import { compareDecimalAmounts } from "@sdp/payments/decimal";
import { isRampEventProvider } from "@sdp/payments/ramps/shared";
import type { MoneygramRampEvent } from "@sdp/types";
import { z } from "zod";
import type { PaymentTransferRow, PaymentTransferStatus } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AppContext, getPaymentsRepository } from "../../context";
import { mapTransferRow } from "../../mappers";
import { coinbaseRampEventSchema, moneygramRampEventSchema } from "../../schemas";

const TERMINAL_RAMP_STATUSES = [
  "completed",
  "failed",
  "expired",
  "canceled",
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
  if (leg.wallet_id !== ramp.wallet_id) {
    throw badRequest("Crypto transfer was not sent from the off-ramp wallet.");
  }
  if (leg.direction !== "outbound") {
    throw badRequest("Crypto transfer must be outbound.");
  }
  if (leg.token !== ramp.token) {
    throw badRequest("Crypto transfer asset does not match the off-ramp asset.");
  }
  if (ramp.amount !== null && compareDecimalAmounts(leg.amount ?? "0", ramp.amount) !== 0) {
    throw badRequest("Crypto transfer amount does not match the off-ramp amount.");
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

const MONEYGRAM_EVENT_DIRECTION = {
  onramp_completed: "onramp",
  signed: "offramp",
  completed: "offramp",
  errored: null,
  closed: null,
} as const satisfies Record<MoneygramRampEvent["kind"], "onramp" | "offramp" | null>;

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
  if (isTerminalRampStatus(transfer.status)) {
    return success(c, { transfer: mapTransferRow(transfer) });
  }

  const expectedDirection = MONEYGRAM_EVENT_DIRECTION[event.kind];
  if (expectedDirection !== null && transfer.type !== expectedDirection) {
    throw badRequest(
      `MoneyGram ${event.kind} events only apply to ${expectedDirection} transfers.`
    );
  }

  const moneygramData = readMoneygramData(transfer);
  if (event.kind !== "signed") {
    return recordMoneygramAdvisoryEvent(c, transfer, moneygramData, event);
  }
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
  const updated = await repo.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["pending"],
    toStatus: "settling",
    amount: leg.amount,
    providerData: {
      moneygram: {
        ...moneygramData,
        cryptoTransferId: leg.id,
        solanaTxSignature: leg.signature,
      },
    },
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    const current = await repo.getTransferById({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
    });
    if (current?.status === "settling" && readMoneygramData(current).cryptoTransferId === leg.id) {
      return transferResponse(c, current);
    }
    throw conflict("Off-ramp transfer changed while the signed event was recorded.");
  }
  return transferResponse(c, updated);
}

async function recordMoneygramAdvisoryEvent(
  c: AppContext,
  transfer: PaymentTransferRow,
  moneygramData: Record<string, unknown>,
  event: Exclude<MoneygramRampEvent, { kind: "signed" }>
) {
  switch (event.kind) {
    case "onramp_completed":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        transactionId: event.transactionId,
        amount: event.amount,
        status: event.status,
        ...(event.referenceNumber ? { referenceNumber: event.referenceNumber } : {}),
      });
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
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        cryptoTransferId: leg.id,
        transactionId: event.transactionId,
        payoutAmount: event.payoutAmount,
        payoutStatus: event.payoutStatus,
        ...(event.referenceNumber ? { referenceNumber: event.referenceNumber } : {}),
      });
    }
    case "errored":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        reason: event.reason,
        ...(event.cryptoTransferId ? { cryptoTransferId: event.cryptoTransferId } : {}),
        ...(event.transactionId ? { transactionId: event.transactionId } : {}),
      });
    case "closed":
      return recordAdvisoryClientEvent(c, transfer, { kind: event.kind });
  }
}
